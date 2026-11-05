import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.STUB_PORT ?? 7317);
const capturesDir = join(import.meta.dir, "..", "captures", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(capturesDir, { recursive: true });

const cannedReasoning = "Stub reasoning: checking that reasoning deltas render.";
const cannedReply = `## Stub reply

This reply comes from the **M0 stub**, not from Devin. It checks *markdown* rendering.

- First item
- Second item with \`inline code\`

\`\`\`csharp
private static int Add(int a, int b)
{
    return a + b;
}
\`\`\`
`;

// A filled-in OpenCode compaction template, so a stub capture can show what OpenCode sends after compaction.
const cannedSummary = `## Objective
- Stub summary for capture tests.

## Requirements
- (none)

## Decisions
- (none)

## Work State
### Completed
- (none)

### Active
- (none)

### Blocked
- (none)

## Next Move
1. (none)

## Relevant Files
- (none)

## Important Context
- (none)
`;
const isCompaction = (body: any) => {
  const last = [...(body?.messages ?? [])].reverse().find((message: any) => message.role === "user");
  const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((part: any) => part.text ?? "").join(" ");
  return /^You MUST summarize the conversation above|did not fill in the required summary template/.test(text);
};

let sequence = 0;

function redactHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = key === "authorization" ? `<redacted, ${value.length} chars>` : value;
  });
  return result;
}

function summarise(body: any): string {
  if (!body || typeof body !== "object") return "";
  const roles: Record<string, number> = {};
  for (const message of body.messages ?? []) roles[message.role] = (roles[message.role] ?? 0) + 1;
  const lastUser = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user");
  const lastUserText = typeof lastUser?.content === "string"
    ? lastUser.content
    : (lastUser?.content ?? []).map((part: any) => part.text ?? `[${part.type}]`).join(" ");
  return [
    `model=${body.model}`,
    `stream=${body.stream}`,
    `roles=${JSON.stringify(roles)}`,
    `tools=${body.tools?.length ?? 0}`,
    `lastUser=${JSON.stringify(String(lastUserText).slice(0, 80))}`,
  ].join(" ");
}

function chunk(model: string, delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function streamReply(model: string, includeUsage: boolean, reply = cannedReply): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      send(chunk(model, { role: "assistant", content: "" }));
      send(chunk(model, { reasoning_content: cannedReasoning }));
      for (let i = 0; i < reply.length; i += 24) {
        send(chunk(model, { content: reply.slice(i, i + 24) }));
        await Bun.sleep(15);
      }
      send(chunk(model, {}, "stop"));
      if (includeUsage) {
        send(`data: ${JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })}\n\n`);
      }
      send("data: [DONE]\n\n");
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

function fullReply(model: string): Response {
  return Response.json({
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: cannedReply }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const raw = await request.text();
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}

    const id = String(++sequence).padStart(3, "0");
    const fileName = `${id}-${request.method}${url.pathname.replace(/\//g, "_")}.json`;
    writeFileSync(
      join(capturesDir, fileName),
      JSON.stringify(
        { time: new Date().toISOString(), method: request.method, path: url.pathname, query: url.search, headers: redactHeaders(request.headers), body },
        null,
        2,
      ),
    );
    console.log(`${id} ${request.method} ${url.pathname} ${summarise(body)}`);

    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "devin", object: "model", owned_by: "devin-acp-bridge" }] });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const model = body?.model ?? "devin";
      const reply = isCompaction(body) ? cannedSummary : cannedReply;
      return body?.stream ? streamReply(model, Boolean(body?.stream_options?.include_usage), reply) : fullReply(model);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`M0 stub listening on http://127.0.0.1:${port}`);
console.log(`Captures: ${capturesDir}`);
