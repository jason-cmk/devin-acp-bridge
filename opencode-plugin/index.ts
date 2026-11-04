import { Model, Plugin, Provider } from "@opencode/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToken } from "../src/auth";
import { buildId, cacheDir, ensureBridge } from "../src/managed";
import { DEFAULT_MODEL_ID, filterModels, type DevinModel } from "../src/models";

const DEFAULTS = {
  provider: "devin",
  exclude: ["fusion-*"],
  refreshMinutes: 5,
};
/** Starting the bridge and its first model list costs a few seconds; do not hold up OpenCode much longer. */
const FIRST_FETCH_WAIT_MS = 20_000;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** OpenCode does not surface plugin console output, so problems go to a file next to the bridge logs. */
function log(level: "error" | "debug", message: string): void {
  if (level === "debug" && process.env.DEVIN_BRIDGE_DEBUG !== "1") return;
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
  const body = (await response.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
  return (body.data ?? []).flatMap((entry) =>
    typeof entry.id === "string" ? [{ id: entry.id, name: typeof entry.name === "string" ? entry.name : entry.id }] : []);
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

    let baseURL = externalBaseURL;
    let models: DevinModel[] = [];

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
            Object.assign(draft, structuredClone(template), { id: model.id, modelID: model.id, name: model.name });
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
          })),
        });
      });
    }

    const refresh = async () => {
      try {
        let nextBaseURL = externalBaseURL;
        if (!nextBaseURL) {
          const state = await ensureBridge({
            build: buildId(join(repoRoot, "src")),
            serverPath: join(repoRoot, "src", "server.ts"),
            execPath: process.execPath,
          });
          nextBaseURL = `http://127.0.0.1:${state.port}/v1`;
        }
        const next = filterModels(await fetchModels(nextBaseURL, resolveToken().value), exclude);
        log("debug", `${ctx.location.directory}: ${next.length} models from ${nextBaseURL}`);
        if (nextBaseURL === baseURL && JSON.stringify(next) === JSON.stringify(models)) return;
        baseURL = nextBaseURL;
        if (next.length) models = next;
        await (externalBaseURL ? ctx.model.reload() : ctx.provider.reload());
      } catch (error) {
        log("error", `${ctx.location.directory}: ${(error as Error).message}`);
      }
    };

    await Promise.race([refresh(), new Promise((resolve) => setTimeout(resolve, FIRST_FETCH_WAIT_MS))]);
    const timer = setInterval(() => void refresh(), Math.max(1, minutes) * 60_000);
    return () => clearInterval(timer);
  },
});
