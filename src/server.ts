import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isAuthorized, resolveToken } from "./auth";
import { bridgeCommands, type DevinCommand } from "./commands";
import { debugLog, DevinAgent, type ConfigId } from "./devin";
import {
  completion,
  finishReason,
  isTitleRequest,
  localTitle,
  messageText,
  offersTool,
  openAiUsage,
  sseChunk,
  sseUsageChunk,
  type ChatRequest,
  type Delta,
  type ToolCall,
} from "./openai";
import { removeStateIfOwned, writeState } from "./managed";
import { AGENT_HEADER, devinModeFor } from "./modes";
import { DEFAULT_MODEL_ID, THOUGHT_HEADER, thoughtLevelFor, thoughtLevels, type DevinModel, type ModelCatalog, type ThoughtLevels } from "./models";
import { defaultPolicyPath } from "./permissions";
import { parseAnswers, QUESTION_TOOL, questionToolCall, toolResultText } from "./questions";
import { CARD_TOOL, CardStore, cardToolCall, TurnRenderer } from "./render";
import { compactionSummary, latestUserImages, latestUserText, SessionStore, sessionKey } from "./sessions";
import { devinTitle, TitleBoard } from "./titles";
import { Turn, type TurnStep } from "./turn";

const port = Number(process.env.DEVIN_BRIDGE_PORT ?? 7317);
/** Set by the OpenCode plugin when it starts the bridge (port 0); it reads the chosen port back from here. */
const statePath = process.env.DEVIN_BRIDGE_STATE;
const build = process.env.DEVIN_BRIDGE_BUILD ?? "manual";
const BUSY_WAIT_MS = 5000;
/** Real sessions refresh the catalog for free; this only bounds staleness while idle, at one throwaway session. */
const CATALOG_TTL_MS = 15 * 60_000;
/** How long a Devin turn waits for the answer to its question before the bridge cancels the turn. */
const QUESTION_TIMEOUT_MS = Number(process.env.DEVIN_BRIDGE_QUESTION_TIMEOUT_MS ?? 10 * 60_000);
/** Devin's title arrived about 9 s after the prompt in §11.12; OpenCode generates the title in the background. */
const TITLE_WAIT_MS = 20_000;
const titles = new TitleBoard();
/** OpenCode session key by Devin session ID, so a title that arrives after the turn still finds its request. */
const titleKeys = new Map<string, { key: string; prompt: string }>();
const token = resolveToken();
const devin = new DevinAgent();
devin.onUpdate((sessionId, update) => {
  const entry = titleKeys.get(sessionId);
  const title = entry && devinTitle(update, entry.prompt);
  if (entry && title) titles.offer(entry.key, title);
  const cwd = sessionCwds.get(sessionId);
  if (cwd && update.sessionUpdate === "available_commands_update") {
    commandCache.set(cwd, { value: Promise.resolve(bridgeCommands(update.availableCommands)), fetchedAt: Date.now() });
  }
});
/** Devin's slash commands by cwd, and the cwd of each real session. */
const commandCache = new Map<string, { value: Promise<DevinCommand[]>; fetchedAt: number }>();
const sessionCwds = new Map<string, string>();
const sessions = new SessionStore();
const busySessions = new Set<string>();
type ConfigState = { current?: string; initial?: string };
const sessionModels = new Map<string, ConfigState>();
const sessionModes = new Map<string, ConfigState>();
const sessionThoughts = new Map<string, ConfigState>();
/** Thought levels by Devin model ID; `current` is the model's default level. */
const modelThoughts = new Map<string, ThoughtLevels>();
let thoughtProbe: Promise<void> | undefined;
/** Turns paused on a question, by OpenCode session key. */
type ParkedTurn = { turn: Turn; sessionId: string; timer: ReturnType<typeof setTimeout>; steer?: string };
const parkedTurns = new Map<string, ParkedTurn>();
/** Running turns by OpenCode session key, so a steer message can find its turn (§6.14). */
const liveTurns = new Map<string, { turn: Turn; sessionId: string }>();
/** Steer text sent to Devin, waiting for the turn's response to end. */
const pendingSteers = new Map<string, string>();
/** Card output for the plugin's `devin` tool, by call ID (§6.16). */
const cards = new CardStore();
let catalog: { value: Promise<ModelCatalog>; fetchedAt: number } | undefined;

devin.onExit(() => {
  sessions.clear();
  sessionModels.clear();
  sessionModes.clear();
  sessionThoughts.clear();
  modelThoughts.clear();
  parkedTurns.forEach(({ timer }) => clearTimeout(timer));
  parkedTurns.clear();
  titles.clear();
  titleKeys.clear();
  commandCache.clear();
  sessionCwds.clear();
  catalog = undefined;
});

function park(key: string, sessionId: string, turn: Turn, steer?: string): void {
  const timer = setTimeout(() => {
    if (parkedTurns.get(key)?.turn !== turn) return;
    parkedTurns.delete(key);
    turn.abandon();
    devin.cancel(sessionId).catch(() => {});
  }, QUESTION_TIMEOUT_MS);
  parkedTurns.set(key, { turn, sessionId, timer, ...(steer !== undefined ? { steer } : {}) });
}

/**
 * Resumes the parked turn when the request carries the result of its tool call (a question or a tool card), or
 * ends with the steer message that Devin already has. Any other request means the user moved on, so the bridge
 * cancels the question and the turn, and waits for the turn to end.
 */
async function takeParkedTurn(key: string, body: ChatRequest): Promise<ParkedTurn | undefined> {
  const parked = parkedTurns.get(key);
  if (!parked) return undefined;
  parkedTurns.delete(key);
  clearTimeout(parked.timer);
  if (parked.steer !== undefined && latestUserText(body).trim() === parked.steer.trim()) {
    if (!parked.turn.question) parked.turn.answer(undefined);
    sessions.record(key, parked.sessionId, body);
    return parked;
  }
  const callId = parked.turn.pendingCallId;
  const result = callId && toolResultText(body, callId);
  if (callId && result !== undefined) {
    const question = parked.turn.question;
    parked.turn.answer(question && parseAnswers(result, question.form.questions));
    return parked;
  }
  parked.turn.abandon();
  await devin.cancel(parked.sessionId).catch(() => {});
  await parked.turn.finished.catch(() => {});
  return undefined;
}

/** Devin's slash commands for a project; real sessions keep the cache fresh through `available_commands_update`. */
function projectCommands(cwd: string): Promise<DevinCommand[]> {
  const cached = commandCache.get(cwd);
  if (!cached || Date.now() - cached.fetchedAt > CATALOG_TTL_MS) {
    const value = devin.listCommands(cwd).then(bridgeCommands);
    commandCache.set(cwd, { value, fetchedAt: Date.now() });
    value.catch(() => commandCache.delete(cwd));
    return value;
  }
  return cached.value;
}

function modelCatalog(): Promise<ModelCatalog> {
  if (!catalog || Date.now() - catalog.fetchedAt > CATALOG_TTL_MS) {
    const value = devin.listModels(process.cwd());
    catalog = { value, fetchedAt: Date.now() };
    value.catch(() => (catalog = undefined));
  }
  return catalog.value;
}

class RejectedConfigError extends Error {}

/**
 * `undefined` means the value the session started with, so switching back after a change works. Returns the
 * session's config options when the value changed.
 */
async function useConfig(states: Map<string, ConfigState>, configId: ConfigId, sessionId: string, requested: string | undefined): Promise<SessionConfigOption[] | undefined> {
  const state = states.get(sessionId) ?? {};
  states.set(sessionId, state);
  const target = requested ?? state.initial;
  if (!target || target === state.current) return undefined;
  let options: SessionConfigOption[];
  try {
    options = await devin.setConfigOption(sessionId, configId, target);
    debugLog("session/set_config_option", { sessionId, configId, value: target });
  } catch (error) {
    throw new RejectedConfigError(`Devin rejected ${configId} "${target}": ${(error as Error).message}`);
  }
  state.current = target;
  return options;
}

/** Records a model's thought levels; its current level right after the model change is the model's default. */
function noteThought(sessionId: string, model: string | undefined, thought: ThoughtLevels): void {
  sessionThoughts.set(sessionId, { current: thought.current, initial: thought.current });
  if (model) modelThoughts.set(model, thought);
}

/** A variant kept from another model may name a level this model lacks; then the model's default applies. */
function allowedThought(model: string | undefined, header: string | null): string | undefined {
  const requested = thoughtLevelFor(header);
  const levels = model ? modelThoughts.get(model)?.levels : undefined;
  return requested && (!levels || levels.includes(requested)) ? requested : undefined;
}

/** Fills in thought levels for models that no session has used yet, in the background (§6.10). */
function probeThoughts(models: DevinModel[]): void {
  const unknown = models.map((model) => model.id).filter((id) => !modelThoughts.has(id));
  if (thoughtProbe || !unknown.length) return;
  thoughtProbe = devin
    .probeThoughtLevels(process.cwd(), unknown)
    .then((found) => found.forEach((thought, model) => modelThoughts.set(model, thought)))
    .catch((error) => console.error("Could not read Devin's thought levels:", (error as Error).message))
    .finally(() => (thoughtProbe = undefined));
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

/** A complete reply that the bridge writes itself, without a Devin turn. */
function localResponse(body: ChatRequest, text: string): Response {
  const model = body.model ?? "devin";
  if (!body.stream) return Response.json(completion(model, text, "stop"));
  const lines = [sseChunk(model, { role: "assistant", content: text }), sseChunk(model, {}, "stop")];
  if (body.stream_options?.include_usage) lines.push(sseUsageChunk(model));
  lines.push("data: [DONE]\n\n");
  return sseResponse(lines.join(""));
}

/** Waits briefly for Devin's own title for the OpenCode session; falls back to the first words of the prompt. */
async function titleResponse(request: Request, body: ChatRequest): Promise<Response> {
  const openCodeSession = request.headers.get("x-opencode-session");
  const key = openCodeSession && sessionKey(openCodeSession, body, resolveCwd(request));
  const title = key ? await titles.wait(key, TITLE_WAIT_MS) : undefined;
  return localResponse(body, title ?? localTitle(body));
}

async function chatResponse(request: Request, body: ChatRequest): Promise<Response> {
  const model = body.model ?? "devin";
  const cwd = resolveCwd(request);
  const key = sessionKey(request.headers.get("x-opencode-session"), body, cwd);
  const resumed = await takeParkedTurn(key, body);
  if (resumed) return turnResponse(request, body, key, resumed.sessionId, resumed.turn);
  const plan = sessions.plan(key, body);
  debugLog("chat/request", { key, plan: plan.action, model, thought: request.headers.get(THOUGHT_HEADER), messages: body.messages?.map((message) => ({ role: message.role, text: messageText(message) })) });
  if (plan.action === "skip") return localResponse(body, "");
  if (plan.action === "compact") return localResponse(body, compactionSummary(plan.sessionId));
  if (!plan.prompt) return errorResponse(400, "No user message to send to Devin.");

  let sessionId: string;
  if (plan.action === "reuse") {
    sessionId = plan.sessionId;
  } else {
    const created = await devin.newSession(cwd);
    sessionId = created.sessionId;
    sessionCwds.set(sessionId, cwd);
    const initial = created.catalog.defaultModel;
    sessionModels.set(sessionId, { current: initial, initial });
    sessionModes.set(sessionId, { current: created.mode, initial: created.mode });
    noteThought(sessionId, initial, created.thought);
    if (created.catalog.models.length) catalog = { value: Promise.resolve(created.catalog), fetchedAt: Date.now() };
  }
  if (!(await waitUntilIdle(sessionId))) return errorResponse(409, "This Devin session is still running a turn.");
  try {
    const afterModel = await useConfig(sessionModels, "model", sessionId, model === DEFAULT_MODEL_ID ? undefined : model);
    if (afterModel) noteThought(sessionId, sessionModels.get(sessionId)?.current, thoughtLevels(afterModel));
    await useConfig(sessionThoughts, "thought_level", sessionId, allowedThought(sessionModels.get(sessionId)?.current, request.headers.get(THOUGHT_HEADER)));
    await useConfig(sessionModes, "mode", sessionId, devinModeFor(request.headers.get(AGENT_HEADER)));
  } catch (error) {
    if (plan.action === "create") {
      sessionModels.delete(sessionId);
      sessionModes.delete(sessionId);
      sessionThoughts.delete(sessionId);
      await devin.deleteSession(sessionId);
    }
    if (error instanceof RejectedConfigError) return errorResponse(400, error.message);
    throw error;
  }
  sessions.record(key, sessionId, body);
  busySessions.add(sessionId);
  titleKeys.set(sessionId, { key, prompt: plan.prompt });
  const renderer = new TurnRenderer(cwd, { cards: offersTool(body, CARD_TOOL) });
  const turn = new Turn(renderer, (onEvent) => devin.prompt(sessionId, plan.prompt, onEvent, latestUserImages(body)));
  liveTurns.set(key, { turn, sessionId });
  turn.finished
    .finally(() => {
      busySessions.delete(sessionId);
      if (liveTurns.get(key)?.turn === turn) liveTurns.delete(key);
    })
    .catch(() => {});
  return turnResponse(request, body, key, sessionId, turn);
}

/**
 * The plugin forwards OpenCode's steer messages here. Devin reads the text at its next step; the bridge ends the
 * current response so OpenCode records the message, and the next request resumes the same turn.
 */
async function steerResponse(body: { session?: unknown; text?: unknown } | null): Promise<Response> {
  if (typeof body?.session !== "string" || typeof body.text !== "string" || !body.text.trim()) {
    return errorResponse(400, "Expected { session, text }.");
  }
  const key = sessionKey(body.session, {}, "");
  const live = liveTurns.get(key);
  if (!live) return Response.json({ steered: false, reason: "no running turn" });
  pendingSteers.set(key, body.text);
  if (!live.turn.steer()) {
    pendingSteers.delete(key);
    // A tool card already ended the response; OpenCode sends its result together with the steer message.
    const parked = parkedTurns.get(key);
    if (!parked || parked.turn.question || parked.steer !== undefined) return Response.json({ steered: false, reason: "the turn is waiting for an answer" });
    parked.steer = body.text;
  }
  devin.steer(live.sessionId, body.text).catch((error) => console.error("Could not steer the Devin turn:", (error as Error).message));
  return Response.json({ steered: true });
}

/** The tool call a paused response ends with: OpenCode's `question`, or the plugin's `devin` card tool. */
function pauseCall(step: TurnStep): ToolCall | undefined {
  if (step.kind === "question") return questionToolCall(step.question.callId, step.question.form);
  if (step.kind === "card") {
    cards.put(step.callId, step.card);
    return cardToolCall(step.callId, step.card);
  }
  return undefined;
}

/** Streams the turn until it ends or pauses; a paused response ends with one tool call (`pauseCall`). */
async function turnResponse(request: Request, body: ChatRequest, key: string, sessionId: string, turn: Turn): Promise<Response> {
  const model = body.model ?? "devin";
  let attached = true;
  request.signal.addEventListener("abort", () => {
    if (attached && busySessions.has(sessionId)) devin.cancel(sessionId).catch(() => {});
  });
  const next = (sink: (delta: Delta) => void): Promise<TurnStep> =>
    turn.next(sink, offersTool(body, QUESTION_TOOL), offersTool(body, CARD_TOOL)).then(
      (step) => {
        attached = false;
        if (step.kind === "question" || step.kind === "card") park(key, sessionId, turn);
        if (step.kind === "steered") {
          park(key, sessionId, turn, pendingSteers.get(key) ?? "");
          pendingSteers.delete(key);
        }
        return step;
      },
      (error) => {
        attached = false;
        throw error;
      },
    );

  if (!body.stream) {
    let text = "";
    const step = await next((delta) => (text += delta.content ?? ""));
    const usage = openAiUsage(turn.renderer.usage);
    const call = pauseCall(step);
    if (call) return Response.json({ ...completion(model, text, "tool_calls", [call]), usage });
    return Response.json({ ...completion(model, text, step.kind === "done" ? finishReason(step.stopReason) : "stop"), usage });
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
          const step = await next((delta) => send(sseChunk(model, delta)));
          const call = pauseCall(step);
          if (call) {
            send(sseChunk(model, { tool_calls: [{ index: 0, ...call }] }));
            send(sseChunk(model, {}, "tool_calls"));
          } else if (step.kind !== "done") {
            send(sseChunk(model, {}, "stop"));
          } else {
            if (step.stopReason === "cancelled") send(sseChunk(model, { content: "\n\n_Cancelled._" }));
            send(sseChunk(model, {}, finishReason(step.stopReason)));
          }
        } catch (error) {
          console.error("Devin turn failed:", (error as Error).message);
          send(sseChunk(model, { content: `\n\n_The bridge could not complete the Devin turn: ${(error as Error).message}_` }));
          send(sseChunk(model, {}, "stop"));
        }
        if (body.stream_options?.include_usage) send(sseUsageChunk(model, openAiUsage(turn.renderer.usage)));
        send("data: [DONE]\n\n");
        if (!request.signal.aborted) controller.close();
      },
    }),
  );
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
        waitingForAnswer: parkedTurns.size,
      });
    }
    if (!url.pathname.startsWith("/v1/")) return errorResponse(404, "Not found");
    if (!isAuthorized(request.headers.get("authorization"), token.value)) return errorResponse(401, "Missing or wrong bridge token.");

    if (request.method === "GET" && url.pathname === "/v1/models") {
      try {
        const { defaultModel, models } = await modelCatalog();
        probeThoughts(models);
        const defaultName = models.find((candidate) => candidate.id === defaultModel)?.name;
        const entry = (id: string, name: string, devinModel = id) => {
          const thought = modelThoughts.get(devinModel);
          return {
            id,
            name,
            object: "model",
            owned_by: "devin-acp-bridge",
            ...(thought ? { thought_levels: thought.levels, default_thought_level: thought.current } : {}),
          };
        };
        return Response.json({
          object: "list",
          default_model: defaultModel,
          data: [
            entry(DEFAULT_MODEL_ID, defaultName ? `Devin default (${defaultName})` : "Devin default", defaultModel),
            ...models.map((candidate) => entry(candidate.id, candidate.name)),
          ],
        });
      } catch (error) {
        return errorResponse(502, `Could not read Devin's model list: ${(error as Error).message}`);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/commands") {
      try {
        return Response.json({ data: await projectCommands(resolveCwd(request)) });
      } catch (error) {
        return errorResponse(502, `Could not read Devin's commands: ${(error as Error).message}`);
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/cards/")) {
      const card = cards.get(decodeURIComponent(url.pathname.slice("/v1/cards/".length)));
      return card ? Response.json(card) : errorResponse(404, "No card with this call ID.");
    }
    if (request.method === "POST" && url.pathname === "/v1/steer") {
      return steerResponse((await request.json().catch(() => null)) as { session?: unknown; text?: unknown } | null);
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = (await request.json().catch(() => null)) as ChatRequest | null;
      if (!body) return errorResponse(400, "The request body is not valid JSON.");
      try {
        return isTitleRequest(body) ? await titleResponse(request, body) : await chatResponse(request, body);
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
