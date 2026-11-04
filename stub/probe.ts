import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";

const cwd = process.argv[2] ?? process.cwd();
const child = spawn("devin", ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
);

const updates: unknown[] = [];
await acp
  .client({ name: "devin-acp-bridge-probe" })
  .onNotification("session/update", ({ params }) => {
    updates.push(params.update);
  })
  .connectWith(stream, async (ctx) => {
    const init = await ctx.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "devin-acp-bridge-probe", version: "0.0.0" },
    });
    console.log("initialize:", JSON.stringify(init, null, 2));
    const session = await ctx.request("session/new", { cwd, mcpServers: [] });
    console.log("session/new:", JSON.stringify(session, null, 2));
    await Bun.sleep(3000);
    console.log("updates after session/new:", JSON.stringify(updates.map((u: any) => u.sessionUpdate)));
  });

child.kill();
