// Plays OpenCode's first turn against a running bridge: the chat request and the title request at the same time
// (one billed Devin turn). Prints the title the bridge returns and how long it took.
// Usage: DEVIN_BRIDGE_TOKEN=e2e-token bun run stub/title-flow.ts [port]
const port = process.argv[2] ?? "7318";
const session = `ses_title_flow_${Date.now()}`;
const user = { role: "user", content: "Bridge test about the capital city of France. Use no tools. Reply with exactly: PARIS" };

function post(messages: unknown[], tools?: unknown[]) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.DEVIN_BRIDGE_TOKEN ?? ""}`,
      "content-type": "application/json",
      "x-opencode-session": session,
      "x-devin-cwd": `${process.cwd()}/e2e`,
    },
    body: JSON.stringify({ model: "devin", stream: false, messages, ...(tools ? { tools } : {}) }),
  }).then((response) => response.json() as Promise<{ choices: Array<{ message: { content: string } }> }>);
}

const start = Date.now();
const [chat, title] = await Promise.all([
  post([{ role: "system", content: "You are OpenCode." }, user], [{ type: "function", function: { name: "read", parameters: {} } }]),
  post([{ role: "system", content: "You name conversations. Reply with a short title." }, user]).then((reply) => ({ reply, ms: Date.now() - start })),
]);
console.log("reply:", chat.choices[0]?.message.content);
console.log(`title after ${title.ms} ms:`, title.reply.choices[0]?.message.content);
export {};
