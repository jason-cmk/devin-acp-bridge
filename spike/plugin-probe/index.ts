import { Model, Plugin, Provider } from "@opencode/plugin";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const logDir = join(homedir(), ".cache", "devin-acp-bridge");
const log = (message: string) => {
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, "spike-plugin.log"), `${new Date().toISOString()} pid=${process.pid} ${message}\n`);
};

let instances = 0;
const moduleLoadedAt = Date.now();

/** Throwaway probe for the option 1 spike: runtime facts and runtime provider registration. Not shipped. */
export default Plugin.define({
  id: "devin-acp-bridge.spike",
  async setup(ctx) {
    instances += 1;
    log(`module state: instances=${instances} moduleLoadedAt=${moduleLoadedAt}`);
    const bun = (globalThis as { Bun?: { version?: string; serve?: unknown } }).Bun;
    const bunOnPath = spawnSync("bun", ["--version"], { encoding: "utf8" });
    log(
      `setup directory=${ctx.location.directory} project=${ctx.location.project.directory} ` +
        `execPath=${process.execPath} bunGlobal=${typeof bun} bunVersion=${bun?.version} bunServe=${typeof bun?.serve} ` +
        `bunOnPath=${bunOnPath.status === 0 ? bunOnPath.stdout.trim() : `error:${bunOnPath.error?.message}`} ` +
        `ppid=${process.ppid}`,
    );

    if (typeof bun?.serve === "function") {
      try {
        const server = (bun.serve as (options: object) => { port: number; stop: () => void })({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response("ok"),
        });
        const reply = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
        log(`Bun.serve in plugin: port=${server.port} reply=${reply}`);
        server.stop();
      } catch (error) {
        log(`Bun.serve in plugin failed: ${(error as Error).message}`);
      }
    }

    const providerID = Provider.ID.make("devinspike");
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Devin spike",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "http://127.0.0.1:7319/v1", apiKey: "spike-token" },
          headers: { "X-Devin-Cwd": ctx.location.directory },
        },
        models: [{ ...Model.Info.default(providerID, Model.ID.make("devin")), name: "Devin spike" }],
      });
    });
    log(`registered provider devinspike for ${ctx.location.directory}`);
    return () => log(`cleanup directory=${ctx.location.directory}`);
  },
});
