import * as acp from "@agentclientprotocol/sdk";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

const cwd = process.argv[2] ?? process.cwd();
const modelsToTry = process.argv.slice(3);
const child = spawn("devin", ["acp"], { stdio: ["pipe", "pipe", "ignore"] });
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
);

function summarise(options: SessionConfigOption[] | null | undefined) {
  return (options ?? []).map((option: any) => ({
    id: option.id,
    current: option.currentValue,
    values: (option.options ?? []).flatMap((entry: any) => entry.options ?? [entry]).map((entry: any) => `${entry.value} = ${entry.name}`),
  }));
}

await acp.client({ name: "devin-acp-bridge-probe" }).connectWith(stream, async (ctx) => {
  await ctx.request("initialize", {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  const session = await ctx.request("session/new", { cwd, mcpServers: [] });
  const initial = summarise(session.configOptions);
  console.log("model names (first 12):", JSON.stringify(initial.find((o) => o.id === "model")?.values.slice(0, 12), null, 2));
  console.log("thought_level at start:", JSON.stringify(initial.find((o) => o.id === "thought_level")));
  for (const model of modelsToTry) {
    const changed = await ctx.request("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: model });
    const after = summarise(changed.configOptions);
    console.log(`after model=${model}:`, JSON.stringify(after.filter((o) => o.id !== "model")));
  }
  await ctx.request("session/delete", { sessionId: session.sessionId });
  console.log("deleted session", session.sessionId);
});
child.kill();
