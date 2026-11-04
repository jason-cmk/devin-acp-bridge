import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

// One billed turn: starts a prompt that runs `sleep 6`, sends a second session/prompt while it runs (Devin
// advertises cognition.ai/midTurnPrompts), and prints when each prompt resolves and what text arrives.
const cwd = process.argv[2] ?? process.cwd();
const child = spawn("devin", ["acp"], { stdio: ["pipe", "pipe", "ignore"] });
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
);
const start = Date.now();
const at = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;

await acp
  .client({ name: "devin-acp-bridge-probe" })
  .onNotification("session/update", ({ params }) => {
    const update: any = params.update;
    if (update.sessionUpdate === "agent_message_chunk") console.log(at(), "[text]", JSON.stringify(update.content?.text));
    else if (update.sessionUpdate === "user_message_chunk") console.log(at(), "[user]", JSON.stringify(update.content?.text));
    else if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) console.log(at(), `[${update.sessionUpdate}]`, update.status ?? "", update.title ?? "");
    else if (!["usage_update", "available_commands_update", "config_option_update", "current_mode_update"].includes(update.sessionUpdate))
      console.log(at(), "[update]", JSON.stringify(update).slice(0, 300));
  })
  .onRequest("session/request_permission", ({ params }) => {
    const allow = params.options.find((option) => option.kind === "allow_once");
    console.log(at(), "[permission]", params.toolCall._meta?.["cognition.ai/editableCommand"], "->", allow?.optionId);
    return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
  })
  .connectWith(stream, async (ctx) => {
    await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const text = (value: string) => [{ type: "text" as const, text: value }];
    const first = ctx
      .request("session/prompt", { sessionId, prompt: text("Probe test. Run exactly this shell command once: sleep 6. Use no other tools. Then reply with exactly: FIRST_DONE") })
      .then((result) => console.log(at(), "[first resolved]", JSON.stringify(result)), (error) => console.log(at(), "[first failed]", error.message));
    await Bun.sleep(4000);
    console.log(at(), "[sending second prompt]");
    const second = ctx
      .request("session/prompt", { sessionId, prompt: text("Also add the word STEERED at the end of your final reply.") })
      .then((result) => console.log(at(), "[second resolved]", JSON.stringify(result)), (error) => console.log(at(), "[second failed]", error.message));
    await Promise.all([first, second]);
    await ctx.request("session/delete", { sessionId });
  });
child.kill();
