import { describe, expect, test } from "bun:test";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { TurnEvent } from "./devin";
import type { Delta } from "./openai";
import { TurnRenderer } from "./render";
import { nativePermissionAnswer } from "./permissions";
import { Turn } from "./turn";

const elicitation = {
  sessionId: "s",
  mode: "form",
  message: "Pick one",
  requestedSchema: { properties: { q0: { type: "string", title: "Pick", oneOf: [{ const: "A", title: "A" }] } } },
} as unknown as CreateElicitationRequest;

const permission: RequestPermissionRequest = {
  sessionId: "s",
  toolCall: { toolCallId: "t1", _meta: { "cognition.ai/editableCommand": "rm x" } },
  options: [
    { optionId: "switch_bypass", name: "Yes, switch to bypass mode", kind: "allow_always" },
    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ],
};
const REJECTED: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "reject_once" } };
const ALLOWED: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow_once" } };

/** A scripted Devin prompt: the test pushes events and decides when it ends. */
function fakePrompt() {
  let onEvent!: (event: TurnEvent) => void;
  let end!: (stopReason: StopReason) => void;
  const run = (handler: (event: TurnEvent) => void) => {
    onEvent = handler;
    return new Promise<StopReason>((resolve) => (end = resolve));
  };
  const say = (text: string) => onEvent({ kind: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  const ask = () => new Promise<CreateElicitationResponse>((respond) => onEvent({ kind: "question", request: elicitation, respond }));
  const askPermission = (remember?: () => void) =>
    new Promise<RequestPermissionResponse>((respond) =>
      onEvent({ kind: "permission-ask", request: permission, reason: "no matching rule", fallback: REJECTED, respond, ...(remember ? { remember } : {}) }),
    );
  const update = (value: SessionUpdate) => onEvent({ kind: "update", update: value });
  return { run, say, update, ask, askPermission, end: (stopReason: StopReason = "end_turn") => end(stopReason) };
}

function collector() {
  const deltas: Delta[] = [];
  return { deltas, sink: (delta: Delta) => deltas.push(delta), text: () => deltas.map((delta) => delta.content ?? "").join("") };
}

describe("Turn", () => {
  test("streams text and resolves done when the prompt ends", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run);
    const out = collector();
    const step = turn.next(out.sink, true);
    devin.say("hello");
    devin.end();
    expect(await step).toEqual({ kind: "done", stopReason: "end_turn" });
    expect(out.text()).toBe("hello");
  });

  test("pauses on a question, then resumes into a second sink after the answer", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run, () => "call_1");
    const first = collector();
    const step = turn.next(first.sink, true);
    devin.say("before ");
    const response = devin.ask();
    const paused = await step;
    expect(paused.kind).toBe("question");
    expect(paused.kind === "question" && paused.question.callId).toBe("call_1");
    expect(turn.question?.form.questions[0]?.header).toBe("Pick");

    devin.say("buffered ");
    const second = collector();
    const resumed = turn.next(second.sink, true);
    turn.answer([["A"]]);
    expect(await response).toEqual({ action: "accept", content: { q0: "A" } });
    expect(turn.question).toBeUndefined();
    devin.say("after");
    devin.end();
    expect(await resumed).toEqual({ kind: "done", stopReason: "end_turn" });
    expect(first.text()).toBe("before ");
    expect(second.text()).toBe("buffered after");
  });

  test("cancels the question and notes it when OpenCode did not offer the question tool", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run);
    const out = collector();
    const step = turn.next(out.sink, false);
    expect(await devin.ask()).toEqual({ action: "cancel" });
    devin.end();
    expect(await step).toEqual({ kind: "done", stopReason: "end_turn" });
    expect(out.text()).toContain("OpenCode did not offer its question tool");
  });

  test("cancels the question when the answer is missing", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run);
    turn.next(() => {}, true);
    const response = devin.ask();
    await Promise.resolve();
    turn.answer(undefined);
    expect(await response).toEqual({ action: "cancel" });
  });

  test.each<{ answer: string[][] | undefined; response: RequestPermissionResponse; line: string }>([
    { answer: [["Allow once"]], response: ALLOWED, line: "> **Permission** allowed by you: `rm x`" },
    { answer: [["Reject"]], response: REJECTED, line: "> **Permission** rejected by you: `rm x`" },
    { answer: [["only if it is safe"]], response: REJECTED, line: "> **Permission** rejected by you: `rm x`" },
    { answer: undefined, response: REJECTED, line: "> **Permission** rejected by you: `rm x`" },
  ])("asks for an unmatched permission and replies to Devin with the user's choice: $answer", async ({ answer, response, line }) => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run, () => "call_p");
    const step = turn.next(() => {}, true);
    const reply = devin.askPermission();
    const paused = await step;
    expect(paused.kind === "question" && paused.question.form.questions[0]?.header).toBe("Permission");
    const second = collector();
    const resumed = turn.next(second.sink, true);
    turn.answer(answer);
    expect(await reply).toEqual(response);
    devin.end();
    await resumed;
    expect(second.text()).toContain(line);
  });

  test.each([
    { name: "saves the rule and allows once", save: () => {}, line: "rule added to the bridge policy file" },
    { name: "allows once and reports a failed save", save: () => { throw new Error("disk full"); }, line: "rule not saved: disk full" },
  ])("Always allow $name", async ({ save, line }) => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run, () => "call_p");
    const step = turn.next(() => {}, true);
    let saved = 0;
    const reply = devin.askPermission(() => { saved++; save(); });
    await step;
    const second = collector();
    const resumed = turn.next(second.sink, true);
    turn.answer([["Always allow this command"]]);
    expect(await reply).toEqual(ALLOWED);
    devin.end();
    await resumed;
    expect(saved).toBe(1);
    expect(second.text()).toContain("> **Permission** allowed by you: `rm x`");
    expect(second.text()).toContain(line);
  });

  test("treats Always allow as a reject when no rule can be saved", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run, () => "call_p");
    const step = turn.next(() => {}, true);
    const reply = devin.askPermission();
    await step;
    turn.next(() => {}, true);
    turn.answer([["Always allow this command"]]);
    expect(await reply).toEqual(REJECTED);
  });

  test("asks two parallel permissions one at a time and replies to each with its own answer", async () => {
    const devin = fakePrompt();
    let calls = 0;
    const turn = new Turn(new TurnRenderer("/"), devin.run, () => `call_${++calls}`);
    const step = turn.next(() => {}, true);
    const firstReply = devin.askPermission();
    const secondReply = devin.askPermission();
    const firstPause = await step;
    expect(firstPause.kind === "question" && firstPause.question.callId).toBe("call_1");

    const middle = collector();
    const secondStep = turn.next(middle.sink, true);
    turn.answer([["Allow once"]]);
    expect(await firstReply).toEqual(ALLOWED);
    const secondPause = await secondStep;
    expect(secondPause.kind === "question" && secondPause.question.callId).toBe("call_2");
    expect(middle.text()).toContain("> **Permission** allowed by you: `rm x`");

    const last = collector();
    const done = turn.next(last.sink, true);
    turn.answer([["Reject"]]);
    expect(await secondReply).toEqual(REJECTED);
    devin.end();
    expect(await done).toEqual({ kind: "done", stopReason: "end_turn" });
    expect(last.text()).toContain("> **Permission** rejected by you: `rm x`");
  });

  test("asks through the native permission check when the request offered it", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run, () => "call_n");
    const step = turn.next(() => {}, { question: true, permission: true });
    const reply = devin.askPermission();
    const paused = await step;
    expect(paused).toEqual({
      kind: "permission",
      callId: "call_n",
      permission: { title: "Run rm x", action: "bash", resources: ["rm x"], save: ["rm x"], chained: false },
    });
    expect(turn.awaitingPermission).toBe(true);
    expect(turn.question).toBeUndefined();
    const out = collector();
    turn.next(out.sink, { question: true, permission: true });
    turn.answer(nativePermissionAnswer("ALLOWED"));
    expect(await reply).toEqual(ALLOWED);
    expect(out.text()).toContain("> **Permission** allowed by you: `rm x`");
  });

  test("saves a rule for OpenCode's Always, and allows once when no rule can be saved", async () => {
    for (const [remember, expectSaved] of [[true, 1], [false, 0]] as const) {
      const devin = fakePrompt();
      const turn = new Turn(new TurnRenderer("/"), devin.run, () => "call_n");
      const step = turn.next(() => {}, { question: true, permission: true });
      let saved = 0;
      const reply = devin.askPermission(remember ? () => void saved++ : undefined);
      await step;
      turn.next(() => {}, { question: true, permission: true });
      turn.answer(nativePermissionAnswer("ALLOWED_ALWAYS"));
      expect(await reply).toEqual(ALLOWED);
      expect(saved).toBe(expectSaved);
    }
  });

  test("rejects when the native permission check returns anything else", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run, () => "call_n");
    const step = turn.next(() => {}, { question: true, permission: true });
    const reply = devin.askPermission();
    await step;
    turn.next(() => {}, { question: true, permission: true });
    turn.answer(nativePermissionAnswer("Error: The user rejected permission"));
    expect(await reply).toEqual(REJECTED);
  });

  test("uses the question when the request offered no native permission check", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run, () => "call_q");
    const step = turn.next(() => {}, { question: true });
    void devin.askPermission();
    const paused = await step;
    expect(paused.kind).toBe("question");
    expect(turn.awaitingPermission).toBe(false);
  });

  test("ends the response with a todo list when the plan changes, and as markdown without the todo tool", async () => {
    const plan = (status: "pending" | "completed"): SessionUpdate => ({
      sessionUpdate: "plan",
      entries: [{ content: "Alpha", status, priority: "medium" }],
    });
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/", { todos: true }), devin.run, () => "call_t");
    const step = turn.next(() => {}, { question: true, todo: true });
    devin.update(plan("pending"));
    expect(await step).toEqual({ kind: "todos", callId: "call_t", entries: [{ content: "Alpha", status: "pending", priority: "medium" }] });
    const out = collector();
    const next = turn.next(out.sink, { question: true, todo: false });
    turn.answer(undefined);
    devin.update(plan("pending"));
    devin.update(plan("completed"));
    devin.end();
    expect(await next).toEqual({ kind: "done", stopReason: "end_turn" });
    expect(out.text()).toContain("- [x] Alpha");
    expect(out.text().match(/\*\*Plan\*\*/g)?.length).toBe(1);
  });

  test("rejects an unmatched permission by policy when OpenCode did not offer the question tool", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run);
    const out = collector();
    const step = turn.next(out.sink, false);
    expect(await devin.askPermission()).toEqual(REJECTED);
    devin.end();
    await step;
    expect(out.text()).toContain("> **Permission** rejected by bridge policy (no matching rule): `rm x`");
  });

  test("yields the attached response on a steer and resumes the same turn into the next one", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run);
    const first = collector();
    const step = turn.next(first.sink, true);
    devin.say("before ");
    expect(turn.steer()).toBe(true);
    expect(await step).toEqual({ kind: "steered" });
    devin.say("buffered ");
    const second = collector();
    const resumed = turn.next(second.sink, true);
    devin.say("after");
    devin.end();
    expect(await resumed).toEqual({ kind: "done", stopReason: "end_turn" });
    expect(first.text()).toBe("before ");
    expect(second.text()).toBe("buffered after");
  });

  test("cannot steer while no response is attached", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run);
    expect(turn.steer()).toBe(false);
    const step = turn.next(() => {}, true);
    devin.ask();
    await step;
    expect(turn.steer()).toBe(false);
  });

  test("ends the response with a card when a tool finishes, and queues a question behind it", async () => {
    const devin = fakePrompt();
    const ids = ["call_card", "call_q"];
    const turn = new Turn(new TurnRenderer("/", { cards: true }), devin.run, () => ids.shift()!);
    const first = collector();
    const step = turn.next(first.sink, { question: true, card: true });
    devin.say("before ");
    devin.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read" });
    devin.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    expect(await step).toEqual({ kind: "card", callId: "call_card", card: { title: "Read file", output: "" } });
    devin.say("after ");
    const answered = devin.ask();
    expect(turn.pendingCallId).toBe("call_card");
    turn.answer(undefined);
    const second = collector();
    const paused = await turn.next(second.sink, { question: true, card: true });
    expect(paused.kind === "question" && paused.question.callId).toBe("call_q");
    expect(first.text()).toBe("before ");
    expect(second.text()).toBe("after ");
    turn.answer([["A"]]);
    expect(await answered).toEqual({ action: "accept", content: { q0: "A" } });
  });

  test("shows a card as markdown when the request did not offer the card tool", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/", { cards: true }), devin.run);
    const out = collector();
    const step = turn.next(out.sink, { question: true, card: false });
    devin.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read" });
    devin.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    devin.end();
    expect(await step).toEqual({ kind: "done", stopReason: "end_turn" });
    expect(out.text()).toBe("> **Read file**\n\n");
  });

  test("abandon answers the pending and queued pauses so a cancelled turn can end", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run);
    const step = turn.next(() => {}, true);
    const first = devin.ask();
    await step;
    const second = devin.ask();
    turn.abandon();
    expect(await first).toEqual({ action: "cancel" });
    expect(await second).toEqual({ action: "cancel" });
  });

  test("returns the final step to a late caller after the prompt ended without a sink", async () => {
    const devin = fakePrompt();
    const turn = new Turn(new TurnRenderer("/"), devin.run);
    devin.end("cancelled");
    await turn.finished;
    expect(await turn.next(() => {}, true)).toEqual({ kind: "done", stopReason: "cancelled" });
  });

  test("rejects the waiting step when the prompt fails", async () => {
    const turn = new Turn(new TurnRenderer("/"), () => Promise.reject(new Error("boom")));
    await expect(turn.next(() => {}, true)).rejects.toThrow("boom");
  });
});
