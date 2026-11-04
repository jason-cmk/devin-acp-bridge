import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isAuthorized, resolveToken } from "./auth";
import { DevinAgent } from "./devin";
import {
  completion,
  finishReason,
  isTitleRequest,
  localTitle,
  sseChunk,
  sseUsageChunk,
  type ChatRequest,
  type Delta,
} from "./openai";
import { removeStateIfOwned, writeState } from "./managed";
import { DEFAULT_MODEL_ID, type ModelCatalog } from "./models";
import { defaultPolicyPath } from "./permissions";
import { TurnRenderer, type TurnUsage } from "./render";
import { SessionStore, sessionKey } from "./sessions";

const port = Number(process.env.DEVIN_BRIDGE_PORT ?? 7317);
/** Set by the OpenCode plugin when it starts the bridge (port 0); it reads the chosen port back from here. */
const statePath = process.env.DEVIN_BRIDGE_STATE;
const build = process.env.DEVIN_BRIDGE_BUILD ?? "manual";
const BUSY_WAIT_MS = 5000;
/** Real sessions refresh the catalog for free; this only bounds staleness while idle, at one throwaway session. */
const CATALOG_TTL_MS = 15 * 60_000;
const token = resolveToken();
const devin = new DevinAgent();
const sessions = new SessionStore();
const busySessions = new Set<string>();
const sessionModels = new Map<string, { current?: string; initial?: string }>();
let catalog: { value: Promise<ModelCatalog>; fetchedAt: number } | undefined;

devin.onExit(() => {
  sessions.clear();
  sessionModels.clear();
  catalog = undefined;
});

function modelCatalog(): Promise<ModelCatalog> {
  if (!catalog || Date.now() - catalog.fetchedAt > CATALOG_TTL_MS) {
    const value = devin.listModels(process.cwd());
    catalog = { value, fetchedAt: Date.now() };
    value.catch(() => (catalog = undefined));
  }
  return catalog.value;
}

class UnknownModelError extends Error {}

/** `devin` means the model the session started with, so switching back to it after another model works. */
async function useModel(sessionId: string, requested: string): Promise<void> {
  const state = sessionModels.get(sessionId) ?? {};
  sessionModels.set(sessionId, state);
  const target = requested === DEFAULT_MODEL_ID ? state.initial : requested;
  if (!target || target === state.current) return;
  try {
    await devin.setModel(sessionId, target);
  } catch (error) {
    throw new UnknownModelError(`Devin rejected model "${target}": ${(error as Error).message}`);
  }
  state.current = target;
}

function resolveCwd(request: Request): string {
  const requested = request.headers.get("x-devin-cwd");
  return requested && isAbsolute(requested) && existsSync(requested) ? requested : process.cwd();
}

async function waitUntilIdle(sessionId: string): Promise<boolean> {
  const deadline = Date.now() + BUSY_WAIT_MS;
  while (busySessions.has(sessionId) && Date.now() < deadline) await Bun.sleep(100);
  return !busySessions.has(sessionId);
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

function sseResponse(body: ReadableStream<Uint8Array> | string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function titleResponse(body: ChatRequest): Response {
  const model = body.model ?? "devin";
  const title = localTitle(body);
  if (!body.stream) return Response.json(completion(model, title, "stop"));
  const lines = [sseChunk(model, { role: "assistant", content: title }), sseChunk(model, {}, "stop")];
  if (body.stream_options?.include_usage) lines.push(sseUsageChunk(model));
  lines.push("data: [DONE]\n\n");
  return sseResponse(lines.join(""));
}

async function chatResponse(request: Request, body: ChatRequest): Promise<Response> {
  const model = body.model ?? "devin";
  const cwd = resolveCwd(request);
  const key = sessionKey(request.headers.get("x-opencode-session"), body, cwd);
  const plan = sessions.plan(key, body);
  if (!plan.prompt) return errorResponse(400, "No user message to send to Devin.");

  let sessionId: string;
  if (plan.action === "reuse") {
    sessionId = plan.sessionId;
  } else {
    const created = await devin.newSession(cwd);
    sessionId = created.sessionId;
    const initial = created.catalog.defaultModel;
    sessionModels.set(sessionId, { current: initial, initial });
    if (created.catalog.models.length) catalog = { value: Promise.resolve(created.catalog), fetchedAt: Date.now() };
  }
  if (!(await waitUntilIdle(sessionId))) return errorResponse(409, "This Devin session is still running a turn.");
  try {
    await useModel(sessionId, model);
  } catch (error) {
    if (plan.action === "create") {
      sessionModels.delete(sessionId);
      await devin.deleteSession(sessionId);
    }
    if (error instanceof UnknownModelError) return errorResponse(400, error.message);
    throw error;
  }
  sessions.record(key, sessionId, body);
  busySessions.add(sessionId);
  request.signal.addEventListener("abort", () => {
    if (busySessions.has(sessionId)) devin.cancel(sessionId).catch(() => {});
  });

  const renderer = new TurnRenderer(cwd);
  const run = (emit: (delta: Delta) => void) =>
    devin
      .prompt(sessionId, plan.prompt, (event) => renderer.handle(event).forEach(emit))
      .finally(() => {
        renderer.finish().forEach(emit);
        busySessions.delete(sessionId);
      });

  if (!body.stream) {
    let text = "";
    const stopReason = await run((delta) => (text += delta.content ?? ""));
    return Response.json({ ...completion(model, text, finishReason(stopReason)), usage: usageOf(renderer.usage) });
  }

  const encoder = new TextEncoder();
  return sseResponse(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (text: string) => {
          if (!request.signal.aborted) controller.enqueue(encoder.encode(text));
        };
        send(sseChunk(model, { role: "assistant", content: "" }));
        try {
          const stopReason = await run((delta) => send(sseChunk(model, delta)));
          if (stopReason === "cancelled") send(sseChunk(model, { content: "\n\n_Cancelled._" }));
          send(sseChunk(model, {}, finishReason(stopReason)));
        } catch (error) {
          console.error("Devin turn failed:", (error as Error).message);
          send(sseChunk(model, { content: `\n\n_The bridge could not complete the Devin turn: ${(error as Error).message}_` }));
          send(sseChunk(model, {}, "stop"));
        }
        if (body.stream_options?.include_usage) send(sseUsageChunk(model, usageOf(renderer.usage)));
        send("data: [DONE]\n\n");
        if (!request.signal.aborted) controller.close();
      },
    }),
  );
}

function usageOf(usage: TurnUsage | undefined) {
  const prompt = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completionTokens, total_tokens: prompt + completionTokens };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        pid: process.pid,
        build,
        devin: devin.running ? "running" : "stopped",
        sessions: sessions.size,
        busy: busySessions.size,
      });
    }
    if (!url.pathname.startsWith("/v1/")) return errorResponse(404, "Not found");
    if (!isAuthorized(request.headers.get("authorization"), token.value)) return errorResponse(401, "Missing or wrong bridge token.");

    if (request.method === "GET" && url.pathname === "/v1/models") {
      try {
        const { defaultModel, models } = await modelCatalog();
        const defaultName = models.find((candidate) => candidate.id === defaultModel)?.name;
        const entry = (id: string, name: string) => ({ id, name, object: "model", owned_by: "devin-acp-bridge" });
        return Response.json({
          object: "list",
          default_model: defaultModel,
          data: [
            entry(DEFAULT_MODEL_ID, defaultName ? `Devin default (${defaultName})` : "Devin default"),
            ...models.map((candidate) => entry(candidate.id, candidate.name)),
          ],
        });
      } catch (error) {
        return errorResponse(502, `Could not read Devin's model list: ${(error as Error).message}`);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = (await request.json().catch(() => null)) as ChatRequest | null;
      if (!body) return errorResponse(400, "The request body is not valid JSON.");
      try {
        return isTitleRequest(body) ? titleResponse(body) : await chatResponse(request, body);
      } catch (error) {
        console.error("Could not start the Devin turn:", (error as Error).message);
        return errorResponse(502, `Could not start the Devin turn: ${(error as Error).message}`);
      }
    }
    return errorResponse(404, "Not found");
  },
});

if (statePath) writeState(statePath, { port: server.port ?? port, pid: process.pid, build });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (statePath) removeStateIfOwned(statePath, process.pid);
    devin.stop();
    process.exit(0);
  });
}

console.log(`devin-acp-bridge ${build} listening on http://127.0.0.1:${server.port}`);
console.log(
  token.source === "env"
    ? "Auth: using DEVIN_BRIDGE_TOKEN from the environment."
    : `Auth: token in ${token.path}. In OpenCode set the provider's "apiKey": "{file:${token.path}}".`,
);
console.log(`Permission policy: ${defaultPolicyPath}${existsSync(defaultPolicyPath) ? "" : " (not found: every permission request is rejected)"}`);
