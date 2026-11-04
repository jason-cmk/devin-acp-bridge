import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

// Runs one billed Devin turn that asks a question, prints the raw elicitation/create request,
// accepts the first option of every enum field, and prints the rest of the turn.
const cwd = process.argv[2] ?? process.cwd();
const child = spawn("devin", ["acp"], { stdio: ["pipe", "pipe", "ignore"] });
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
);

function firstChoice(schema: any): unknown {
  if (schema.type === "array") {
    const items = schema.items ?? {};
    const first = items.enum?.[0] ?? items.anyOf?.[0]?.const ?? items.oneOf?.[0]?.const;
    return first === undefined ? [] : [first];
  }
  return schema.enum?.[0] ?? schema.oneOf?.[0]?.const ?? schema.default ?? "probe answer";
}

await acp
  .client({ name: "devin-acp-bridge-probe" })
  .onNotification("session/update", ({ params }) => {
    const update: any = params.update;
    if (update.sessionUpdate === "agent_message_chunk") process.stdout.write(update.content?.text ?? "");
    else console.log("\n[update]", JSON.stringify(update).slice(0, 600));
  })
  .onRequest("session/request_permission", ({ params }) => {
    console.log("\n[permission]", JSON.stringify(params));
    return { outcome: { outcome: "cancelled" } };
  })
  .onRequest("elicitation/create", ({ params }) => {
    console.log("\n[elicitation/create]", JSON.stringify(params, null, 2));
    const p: any = params;
    const content = Object.fromEntries(Object.entries(p.requestedSchema?.properties ?? {}).map(([key, schema]) => [key, firstChoice(schema)]));
    const response = { action: "accept" as const, content: content as Record<string, string> };
    console.log("[elicitation/response]", JSON.stringify(response));
    return response;
  })
  .onNotification("elicitation/complete", ({ params }) => console.log("\n[elicitation/complete]", JSON.stringify(params)))
  .connectWith(stream, async (ctx) => {
    const init = await ctx.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
    });
    console.log("[initialize]", JSON.stringify(init.agentCapabilities));
    const session = await ctx.request("session/new", { cwd, mcpServers: [] });
    const result = await ctx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text:
            "Probe test. Use your ask-user-question tool exactly once to ask me two questions in one call: " +
            "(1) favourite colour with options Red, Green, Blue (single choice); (2) which fruits I like with options Apple, Pear, Plum (multiple choice). " +
            "Use no other tools. After my answer, reply with one short sentence that repeats my answers.",
        },
      ],
    });
    console.log("\n[stopReason]", result.stopReason);
    await ctx.request("session/delete", { sessionId: session.sessionId });
  });
child.kill();
