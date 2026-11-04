import { existsSync } from "node:fs";
import { answerText, type OpenCodeQuestion } from "../src/questions";

// Plays OpenCode's side of a question round trip against a running bridge (one billed Devin turn).
// Usage: DEVIN_BRIDGE_TOKEN=e2e-token bun run stub/question-flow.ts [port] [--move-on] [--permission[=reject|=always]]
// --move-on sends a new user message instead of the answer; the bridge must cancel the paused turn.
// --permission asks Devin to run a command that no policy rule matches, and answers the permission prompt.
const port = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "7318";
const moveOn = process.argv.includes("--move-on");
const permission = process.argv.find((arg) => arg.startsWith("--permission"));
const marker = `/tmp/devin-bridge-ask-${Date.now()}`;
const token = process.env.DEVIN_BRIDGE_TOKEN ?? "";
const session = `ses_question_flow_${Date.now()}`;
const questionTool = {
  type: "function",
  function: {
    name: "question",
    description: "Ask the user questions.",
    parameters: { type: "object", properties: { questions: { type: "array" } }, required: ["questions"] },
  },
};

type Chunk = { choices: Array<{ delta: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason: string | null }> };

async function chat(messages: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-opencode-session": session, "x-devin-cwd": `${process.cwd()}/e2e` },
    body: JSON.stringify({ model: "devin", stream: true, messages, tools: [questionTool] }),
  });
  let content = "";
  let finish: string | null = null;
  const calls: Array<{ id: string; function: { name: string; arguments: string } }> = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const chunk = JSON.parse(line.slice(6)) as Chunk;
    for (const choice of chunk.choices) {
      content += choice.delta.content ?? "";
      calls.push(...(choice.delta.tool_calls ?? []));
      finish = choice.finish_reason ?? finish;
    }
  }
  return { status: response.status, content, finish, calls };
}

const user = {
  role: "user",
  content: permission
    ? `Bridge test. Run exactly this shell command once: touch ${marker}. Use no other tools. ` +
      "Then reply with exactly RAN if it ran, or REJECTED if it was rejected."
    : "Bridge test. Use your ask-user-question tool once to ask me my favourite colour (options Red, Green, Blue). " +
      "Use no other tools. After my answer, reply with exactly: ANSWER=<colour>",
};
const first = await chat([user]);
console.log("first:", JSON.stringify(first, null, 2));
const call = first.calls[0];
if (first.finish !== "tool_calls" || !call) process.exit(1);

const { questions } = JSON.parse(call.function.arguments) as { questions: OpenCodeQuestion[] };
const permissionLabels: Record<string, string> = { "--permission": "Allow once", "--permission=reject": "Reject", "--permission=always": "Always allow this command" };
const pick = (question: OpenCodeQuestion) => (permission ? permissionLabels[permission] : question.options.at(-1)?.label);
const answers = questions.map((question) => [pick(question) ?? "custom"]);
const assistant = { role: "assistant", content: first.content, tool_calls: [{ id: call.id, type: "function", function: call.function }] };
const second = await chat(
  moveOn
    ? [user, assistant, { role: "user", content: "Forget the question. Use no tools and reply with exactly: MOVED_ON" }]
    : [user, assistant, { role: "tool", tool_call_id: call.id, content: answerText(questions, answers) }],
);
console.log(moveOn ? "moved on" : `answered with: ${JSON.stringify(answers)}`);
console.log("second:", JSON.stringify(second, null, 2));
if (permission) console.log(`${marker} exists: ${existsSync(marker)}`);
