// Plays OpenCode's side of a steer message against a running bridge (one billed Devin turn): starts a long
// turn, posts /v1/steer while it streams, then sends the request that carries the steer message, as OpenCode
// does at the next step boundary.
// Usage: DEVIN_BRIDGE_TOKEN=e2e-token bun run stub/steer-flow.ts [port]
const port = process.argv[2] ?? "7318";
const session = `ses_steer_flow_${Date.now()}`;
const base = `http://127.0.0.1:${port}/v1`;
const headers = {
  authorization: `Bearer ${process.env.DEVIN_BRIDGE_TOKEN ?? ""}`,
  "content-type": "application/json",
  "x-opencode-session": session,
  "x-devin-cwd": `${process.cwd()}/e2e`,
};
const start = Date.now();
const at = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;

async function chat(messages: unknown[]) {
  const response = await fetch(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "devin", stream: true, messages }) });
  let content = "";
  let finish: string | null = null;
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const choice = (JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string }; finish_reason: string | null }> }).choices[0];
    content += choice?.delta.content ?? "";
    finish = choice?.finish_reason ?? finish;
  }
  return { content, finish, at: at() };
}

const user = { role: "user", content: "Bridge test. Use no tools. Write the numbers from 1 to 300 in words, one per line, and nothing else." };
const steer = "Stop the list now. Reply with exactly the word STEERED and nothing else.";
const first = chat([user]);
await Bun.sleep(5000);
const steered = await fetch(`${base}/steer`, { method: "POST", headers, body: JSON.stringify({ session, text: steer }) }).then((r) => r.json());
console.log(at(), "steer:", JSON.stringify(steered));
const one = await first;
console.log(one.at, "first finish:", one.finish, "chars:", one.content.length, "tail:", JSON.stringify(one.content.slice(-60)));
const two = await chat([user, { role: "assistant", content: one.content }, { role: "user", content: steer }]);
console.log(two.at, "second finish:", two.finish, "content:", JSON.stringify(two.content.slice(0, 200)), "tail:", JSON.stringify(two.content.slice(-60)));
export {};
