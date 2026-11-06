import { Model, Plugin, Provider } from "@opencode/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToken } from "../src/auth";
import { COMMAND_PREFIX, commandPrompt, type DevinCommand } from "../src/commands";
import { buildId, cacheDir, ensureBridge } from "../src/managed";
import { AGENT_HEADER } from "../src/modes";
import { DEFAULT_MODEL_ID, filterModels, THOUGHT_HEADER, thoughtLevelFor, type DevinModel } from "../src/models";
import { type NativePermission, PERMISSION_ALLOWED_ALWAYS_RESULT, PERMISSION_ALLOWED_RESULT, PERMISSION_TOOL } from "../src/permissions";
import { CARD_CALL_PREFIX, CARD_TOOL } from "../src/render";

/** Metadata key that marks the plugin's native permission checks for Devin's calls. */
const DEVIN_PERMISSION_FLAG = "devinBridge";

const DEFAULTS = {
  provider: "devin",
  exclude: ["fusion-*"],
  refreshMinutes: 5,
};
/** Starting the bridge and its first model list costs a few seconds; do not hold up OpenCode much longer. */
const FIRST_FETCH_WAIT_MS = 20_000;
const THOUGHT_REFETCH_MS = 45_000;
const STEER_RETRY_MS = 5_000;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Set from the `debug` plugin option or `DEVIN_BRIDGE_DEBUG=1`. */
let debugEnabled = process.env.DEVIN_BRIDGE_DEBUG === "1";

/** OpenCode does not surface plugin console output, so problems go to a file next to the bridge logs. */
function log(level: "error" | "debug", message: string): void {
  if (level === "debug" && !debugEnabled) return;
  mkdirSync(cacheDir, { recursive: true });
  appendFileSync(join(cacheDir, "opencode-plugin.log"), `${new Date().toISOString()} ${level} ${message}\n`);
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

async function fetchModels(baseURL: string, token: string): Promise<DevinModel[]> {
  const response = await fetch(`${baseURL}/models`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GET ${baseURL}/models returned ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { data?: Array<{ id?: unknown; name?: unknown; thought_levels?: unknown; default_thought_level?: unknown }> };
  return (body.data ?? []).flatMap((entry) => {
    if (typeof entry.id !== "string") return [];
    const levels = stringList(entry.thought_levels, []);
    return [{
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      ...(levels.length ? { thoughtLevels: levels } : {}),
      ...(typeof entry.default_thought_level === "string" ? { defaultThoughtLevel: entry.default_thought_level } : {}),
    }];
  });
}

/** How long a permission check waits for OpenCode's reply event after `assert` resolves. */
const REPLY_WAIT_MS = 1000;

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (let value = read(); ; value = read()) {
    if (value !== undefined || Date.now() >= end) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The permission check that the bridge stored for this call ID, or undefined when the bridge does not have it. */
async function permissionCheck(baseURL: string | undefined, callId: string): Promise<NativePermission | undefined> {
  if (!baseURL) return undefined;
  try {
    const response = await fetch(`${baseURL}/permissions/${encodeURIComponent(callId)}`, {
      headers: { authorization: `Bearer ${resolveToken().value}` },
    });
    if (!response.ok) return undefined;
    const check = (await response.json()) as Partial<NativePermission>;
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
    if (typeof check.action !== "string" || !strings(check.resources) || !strings(check.save)) return undefined;
    return { title: String(check.title ?? ""), action: check.action, resources: check.resources, save: check.save, chained: check.chained === true };
  } catch {
    return undefined;
  }
}

type CardResult = { content: string; metadata: Record<string, unknown> };

/** The card result that the bridge stored for this call ID; a note instead when the bridge does not have it. */
async function cardResult(baseURL: string | undefined, callId: string): Promise<CardResult> {
  const unavailable = (reason: string): CardResult => ({ content: `(output unavailable: ${reason})`, metadata: {} });
  if (!baseURL) return unavailable("the bridge is not running");
  try {
    const response = await fetch(`${baseURL}/cards/${encodeURIComponent(callId)}`, {
      headers: { authorization: `Bearer ${resolveToken().value}` },
    });
    if (!response.ok) return unavailable(`bridge returned ${response.status}`);
    const card = (await response.json()) as { tool?: unknown; output?: unknown; metadata?: unknown };
    const output = typeof card.output === "string" ? card.output : "";
    const metadata = card.metadata && typeof card.metadata === "object" ? (card.metadata as Record<string, unknown>) : {};
    // OpenCode's shell renderer prints the content under the command; an empty command output stays empty.
    return { content: output || (card.tool === "shell" ? "" : "(no output)"), metadata };
  } catch (error) {
    return unavailable((error as Error).message);
  }
}

async function fetchCommands(baseURL: string, token: string, cwd: string): Promise<DevinCommand[]> {
  const response = await fetch(`${baseURL}/commands`, {
    headers: { authorization: `Bearer ${token}`, "x-devin-cwd": cwd },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GET ${baseURL}/commands returned ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { data?: DevinCommand[] };
  return (body.data ?? []).filter((command) => typeof command?.name === "string" && typeof command.description === "string");
}

/** One OpenCode variant per Devin thought level. No variant selected means the model's default level. */
function variants(model: DevinModel): Model.Variant[] {
  return (model.thoughtLevels ?? []).map((level) => ({ id: Model.VariantID.make(level) }));
}

/**
 * Managed mode (default): starts one shared bridge on a random port, like an editor starting a language server,
 * and registers the `devin` provider for this project with the live model list and this project as Devin's cwd.
 *
 * External mode (`baseURL` option set): the bridge runs separately and the provider comes from opencode.jsonc;
 * the plugin only replaces that provider's models with the live list.
 */
export default Plugin.define({
  id: "devin-acp-bridge",
  async setup(ctx) {
    const providerID = typeof ctx.options.provider === "string" ? ctx.options.provider : DEFAULTS.provider;
    const exclude = stringList(ctx.options.exclude, DEFAULTS.exclude);
    const minutes = typeof ctx.options.refreshMinutes === "number" ? ctx.options.refreshMinutes : DEFAULTS.refreshMinutes;
    const externalBaseURL = typeof ctx.options.baseURL === "string" ? ctx.options.baseURL.replace(/\/$/, "") : undefined;
    const withCommands = ctx.options.commands !== false;
    const withCards = ctx.options.toolCards === true;
    const withNativePermissions = ctx.options.nativePermissions !== false;
    // The user's reply to each native permission check, by the `permission` call ID. Filled from
    // `permission.asked` (request ID → call ID) and `permission.replied` events.
    const permissionCalls = new Map<string, string>();
    const permissionReplies = new Map<string, "once" | "always" | "reject">();
    if (ctx.options.debug === true) debugEnabled = true;

    let baseURL = externalBaseURL;
    let models: DevinModel[] = [];
    let commands: DevinCommand[] = [];

    // Devin's slash commands as `/devin:<name>`. Running one sends `/<name> <args>` to the session's model, and
    // Devin reads the command from the prompt (spec §6.15).
    if (withCommands) {
      await ctx.command.transform((editor) => {
        for (const command of commands) {
          editor.add({
            name: `${COMMAND_PREFIX}${command.name}`,
            description: command.hint ? `${command.description} ${command.hint}` : command.description,
            execute: async (input) => {
              await ctx.session.prompt({ sessionID: input.sessionID, text: commandPrompt(command.name, input.prompt.text), delivery: input.delivery });
            },
          });
        }
      });
    }

    // Tool cards (opt-in, spec §6.16): the bridge ends a response with one call for each tool Devin has already
    // run. The call names the OpenCode tool whose renderer fits (`shell`, `edit`, `read`, …), so the TUI draws
    // it like its own tools. The `execute.before` hook sends every card call to the no-op `devin_card` tool, which
    // reads the result from the bridge by call ID. The hook is registered first: the bridge sends cards only
    // when the request offers `devin_card`, so OpenCode never runs a tool that a card call names.
    if (withCards) {
      await ctx.tool.hook("execute.before", (event) => {
        if (String(event.id).startsWith(CARD_CALL_PREFIX)) event.tool = CARD_TOOL;
      });
      await ctx.tool.transform((editor) => {
        editor.add({
          name: CARD_TOOL,
          description: "Shows a tool call that Devin already ran. It has no effect; never call it yourself.",
          // Any input: the call carries the input of the OpenCode tool it is drawn as.
          input: { type: "object", properties: {}, additionalProperties: true },
          options: { codemode: false },
          execute: async (_input, context) => cardResult(baseURL, context.id),
        });
      });
    }

    // Native permission prompts (spec §6.17): the bridge ends a response with a `permission` call when Devin
    // asks a permission that no bridge policy rule decided. This tool asks OpenCode's own permission system, so
    // the user's `permission` rules, the native dialog, "Always" and auto-accept all apply.
    if (withNativePermissions) {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: PERMISSION_TOOL,
          description: "Asks the user to allow a tool call that Devin wants to run. It has no other effect; never call it yourself.",
          input: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
          options: { codemode: false },
          execute: async (input, context) => {
            const title = typeof (input as { title?: unknown } | undefined)?.title === "string" ? (input as { title: string }).title : PERMISSION_TOOL;
            const check = await permissionCheck(baseURL, context.id);
            if (!check) throw new Error("The bridge has no permission request for this call, so it stays rejected.");
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: check.action,
              resources: check.resources,
              save: check.save,
              metadata: { [DEVIN_PERMISSION_FLAG]: true, title: check.title, chained: check.chained },
              source: { type: "tool", messageID: context.messageID, id: context.id },
            });
            // "Always" makes the bridge save an exact-command allow rule (spec §6.17). The reply event can arrive
            // just after `assert` resolves, so wait briefly for it.
            const reply = await waitFor(() => permissionReplies.get(context.id), REPLY_WAIT_MS);
            permissionReplies.delete(context.id);
            return { content: reply === "always" ? PERMISSION_ALLOWED_ALWAYS_RESULT : PERMISSION_ALLOWED_RESULT, metadata: { title } };
          },
        });
      });
      // OpenCode's agents start with a broad `* allow` rule, so a Devin call would be allowed with no prompt.
      // Devin's calls therefore never get `allow` from a rule: they ask, unless a rule denies them. Allow rules
      // live in the bridge policy file, which decides before this check; "Always" saves one there.
      await ctx.permission.hook("evaluate", (evaluation) => {
        if (evaluation.metadata?.[DEVIN_PERMISSION_FLAG] !== true) return;
        log("debug", `evaluate ${evaluation.action} ${JSON.stringify(evaluation.resources)} effect=${evaluation.effect}`);
        if (evaluation.effect === "allow") evaluation.effect = "ask";
      });
    }

    // The bridge picks Devin's session mode from the OpenCode agent (src/modes.ts), and the thought level from
    // the model variant.
    await ctx.session.hook("model.request", (request) => {
      request.headers[AGENT_HEADER] = request.agent;
      const level = thoughtLevelFor(request.model.variant);
      if (level) request.headers[THOUGHT_HEADER] = level;
    }, { providerID });

    if (externalBaseURL) {
      // A provider transform cannot see providers defined in opencode.jsonc; a model transform runs after config.
      await ctx.model.transform((editor) => {
        if (models.length === 0) return;
        const existing = editor.list(providerID);
        const template = editor.get(providerID, DEFAULT_MODEL_ID) ?? existing[0];
        if (!template) return;
        const wanted = new Set(models.map((model) => model.id));
        existing.filter((model) => !wanted.has(model.id)).forEach((model) => editor.remove(providerID, model.id));
        for (const model of models) {
          editor.update(providerID, model.id, (draft) => {
            Object.assign(draft, structuredClone(template), { id: model.id, modelID: model.id, name: model.name, variants: variants(model) });
          });
        }
      });
    } else {
      const id = Provider.ID.make(providerID);
      await ctx.provider.transform((editor) => {
        if (!baseURL) return;
        const listed = models.length ? models : [{ id: DEFAULT_MODEL_ID, name: "Devin default" }];
        editor.add({
          info: {
            ...Provider.Info.empty(id),
            name: "Devin (ACP bridge)",
            activation: "enabled",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL, apiKey: resolveToken().value, chunkTimeout: false },
            headers: { "X-Devin-Cwd": ctx.location.directory },
          },
          models: listed.map((model) => ({
            ...Model.Info.default(id, Model.ID.make(model.id)),
            name: model.name,
            compatibility: { reasoningField: "reasoning_content" },
            limit: { context: 1_000_000, output: 128_000 },
            variants: variants(model),
          })),
        });
      });
    }

    const refresh = async () => {
      try {
        let nextBaseURL = externalBaseURL;
        if (!nextBaseURL) {
          // The suffix makes a bridge started with the other debug setting count as stale, so it is replaced.
          const build = buildId(join(repoRoot, "src"));
          const state = await ensureBridge({
            build: debugEnabled ? `${build}-debug` : build,
            serverPath: join(repoRoot, "src", "server.ts"),
            execPath: process.execPath,
            env: debugEnabled ? { ...process.env, DEVIN_BRIDGE_DEBUG: "1" } : process.env,
          });
          nextBaseURL = `http://127.0.0.1:${state.port}/v1`;
        }
        const token = resolveToken().value;
        const next = filterModels(await fetchModels(nextBaseURL, token), exclude);
        log("debug", `${ctx.location.directory}: ${next.length} models from ${nextBaseURL}`);
        if (nextBaseURL !== baseURL || JSON.stringify(next) !== JSON.stringify(models)) {
          baseURL = nextBaseURL;
          if (next.length) models = next;
          await (externalBaseURL ? ctx.model.reload() : ctx.provider.reload());
        }
        // After the models: reading the commands opens a Devin session and can take seconds.
        if (withCommands) {
          const nextCommands = await fetchCommands(nextBaseURL, token, ctx.location.directory).catch((error: Error) => {
            log("error", `${ctx.location.directory}: ${error.message}`);
            return commands;
          });
          if (JSON.stringify(nextCommands) !== JSON.stringify(commands)) {
            commands = nextCommands;
            await ctx.command.reload();
          }
        }
      } catch (error) {
        log("error", `${ctx.location.directory}: ${(error as Error).message}`);
      }
    };

    // OpenCode delivers a steer message only at the next step boundary, and one Devin turn is one step. The
    // bridge hands the text to the running Devin turn and ends the step early (spec §6.14).
    const events = new AbortController();
    const forwardSteers = async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.inbox.enqueued"], signal: events.signal })) {
        if (event.type !== "session.inbox.enqueued" || !baseURL) continue;
        const { sessionID, item } = event.data;
        if (item.type !== "user" || item.delivery !== "steer") continue;
        if (event.location && event.location.directory !== ctx.location.directory) continue;
        const response = await fetch(`${baseURL}/steer`, {
          method: "POST",
          headers: { authorization: `Bearer ${resolveToken().value}`, "content-type": "application/json" },
          body: JSON.stringify({ session: sessionID, text: item.payload.text }),
        }).catch((error: Error) => error);
        log("debug", `steer ${sessionID}: ${response instanceof Error ? response.message : `${response.status} ${await response.text()}`}`);
      }
    };
    const trackPermissionReplies = async () => {
      for await (const event of ctx.event.subscribe({ types: ["permission.asked", "permission.replied"], signal: events.signal })) {
        if (event.type === "permission.asked") {
          const { id, metadata, source } = event.data;
          if (metadata?.[DEVIN_PERMISSION_FLAG] === true && source?.id) permissionCalls.set(id, source.id);
        } else if (event.type === "permission.replied") {
          const callId = permissionCalls.get(event.data.requestID);
          if (!callId) continue;
          permissionCalls.delete(event.data.requestID);
          permissionReplies.set(callId, event.data.reply);
          log("debug", `permission ${callId}: ${event.data.reply}`);
        }
      }
    };
    if (withNativePermissions) {
      void (async () => {
        while (!events.signal.aborted) {
          await trackPermissionReplies().catch((error: Error) => {
            if (!events.signal.aborted) log("error", `${ctx.location.directory}: permission events stopped, retrying: ${error.message}`);
          });
          await new Promise((resolve) => setTimeout(resolve, STEER_RETRY_MS));
        }
      })();
    }
    void (async () => {
      while (!events.signal.aborted) {
        await forwardSteers().catch((error: Error) => {
          if (!events.signal.aborted) log("error", `${ctx.location.directory}: steer events stopped, retrying: ${error.message}`);
        });
        await new Promise((resolve) => setTimeout(resolve, STEER_RETRY_MS));
      }
    })();

    await Promise.race([refresh(), new Promise((resolve) => setTimeout(resolve, FIRST_FETCH_WAIT_MS))]);
    const timer = setInterval(() => void refresh(), Math.max(1, minutes) * 60_000);
    // The bridge reads thought levels in the background after the first model list, so fetch once more soon.
    const early = setTimeout(() => void refresh(), THOUGHT_REFETCH_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(early);
      events.abort();
    };
  },
});
