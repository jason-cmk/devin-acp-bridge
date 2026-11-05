import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TurnEvent } from "./devin";
import type { Delta } from "./openai";
import { TurnRenderer } from "./render";

const cwd = "/work/app";

function text(value: string): TurnEvent {
  return { kind: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } };
}

function update(value: SessionUpdate): TurnEvent {
  return { kind: "update", update: value };
}

function output(renderer: TurnRenderer, events: TurnEvent[]): string {
  const deltas: Delta[] = [...events.flatMap((event) => renderer.handle(event)), ...renderer.finish()];
  return deltas.map((delta) => delta.content ?? "").join("");
}

describe("TurnRenderer", () => {
  test("separates text from a tool line with blank lines", () => {
    const result = output(new TurnRenderer(cwd), [
      text("Reading the file."),
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", locations: [{ path: "/work/app/src/a.ts" }] }),
      text("Done."),
    ]);
    expect(result).toBe("Reading the file.\n\n> **Read file** `src/a.ts`\n\nDone.");
  });

  test("announces each tool call once across updates", () => {
    const result = output(new TurnRenderer(cwd), [
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read" }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "3 lines" } }] }),
    ]);
    expect(result).toBe("> **Read file**\n\n");
  });

  test("shows the command for execute tools and their output when they complete", () => {
    const result = output(new TurnRenderer(cwd), [
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran git", kind: "execute", rawInput: { command: "git status --short" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: " M src/a.ts" } }] }),
    ]);
    expect(result).toBe("> **Run** `git status --short`\n\n```text\nM src/a.ts\n```\n\n");
  });

  test("shows shell output that Devin streamed before an empty completed update, like devin acp does", () => {
    const result = output(new TurnRenderer(cwd), [
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran echo", kind: "execute", rawInput: { command: "echo bridge-ok" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "bridge-ok" } }], _meta: { "cognition.ai/terminalPreview": true } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "bridge-ok" } }], _meta: { terminal_exit: { terminal_id: "x", exit_code: 0, signal: null } } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
    ]);
    expect(result).toBe("> **Run** `echo bridge-ok`\n\n```text\nbridge-ok\n```\n\n");
  });

  test("hides Devin's placeholder output for a silent command", () => {
    const result = output(new TurnRenderer(cwd), [
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran touch", kind: "execute", rawInput: { command: "touch x" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "Exited with code 0" } }] }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
    ]);
    expect(result).toBe("> **Run** `touch x`\n\n");
  });

  test("reports a non-zero exit code for shell commands", () => {
    const result = output(new TurnRenderer(cwd), [
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran false", kind: "execute", rawInput: { command: "false" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", _meta: { terminal_exit: { terminal_id: "x", exit_code: 1, signal: null } } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" }),
    ]);
    expect(result).toBe("> **Run** `false`\n\n> ✗ **Ran false** exited with code 1\n\n");
  });

  test("renders a diff once even when Devin repeats it in a later update", () => {
    const diff = { type: "diff" as const, path: "/work/app/scratch.txt", oldText: "a\nb\n", newText: "a\nB\n" };
    const result = output(new TurnRenderer(cwd), [
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit file", kind: "edit", content: [diff], locations: [{ path: diff.path }] }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [diff] }),
    ]);
    expect(result).toBe("> **Edit file** `scratch.txt`\n\n`scratch.txt`\n\n```diff\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n```\n\n");
  });

  test("holds tool lines until an open code fence closes", () => {
    const result = output(new TurnRenderer(cwd), [
      text("```ts\nconst a = 1;\n"),
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read" }),
      text("```\nAfter."),
    ]);
    expect(result).toBe("```ts\nconst a = 1;\n```\n\n> **Read file**\n\nAfter.");
  });

  test("tracks a fence marker split across chunks", () => {
    const result = output(new TurnRenderer(cwd), [
      text("``"),
      text("`\ncode\n"),
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read" }),
      text("```\n"),
    ]);
    expect(result).toBe("```\ncode\n```\n\n> **Read file**\n\n");
  });

  test("closes a fence the agent left open at the end of the turn before flushing", () => {
    const result = output(new TurnRenderer(cwd), [
      text("```\ncode"),
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read" }),
    ]);
    expect(result).toBe("```\ncode\n```\n\n> **Read file**\n\n");
  });

  test("shows the first plan immediately and the final plan at the end when it changed", () => {
    const result = output(new TurnRenderer(cwd), [
      update({ sessionUpdate: "plan", entries: [{ content: "Read", priority: "medium", status: "in_progress" }, { content: "Edit", priority: "medium", status: "pending" }] }),
      update({ sessionUpdate: "plan", entries: [{ content: "Read", priority: "medium", status: "completed" }, { content: "Edit", priority: "medium", status: "in_progress" }] }),
      update({ sessionUpdate: "plan", entries: [{ content: "Read", priority: "medium", status: "completed" }, { content: "Edit", priority: "medium", status: "completed" }] }),
    ]);
    expect(result).toBe(
      "**Plan**\n\n- [ ] **Read** _(in progress)_\n- [ ] Edit\n\n**Plan**\n\n- [x] Read\n- [x] Edit\n\n",
    );
  });

  test("does not repeat a failure that the bridge itself rejected", () => {
    const result = output(new TurnRenderer(cwd), [
      { kind: "permission", allowed: false, reason: "no matching rule", request: { sessionId: "s", toolCall: { toolCallId: "t1", _meta: { "cognition.ai/editableCommand": "rm x" } }, options: [] } },
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran rm", kind: "execute", rawInput: { command: "rm x" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ type: "content", content: { type: "text", text: "Tool execution was rejected" } }] }),
    ]);
    expect(result).toBe("> **Permission** rejected by bridge policy (no matching rule): `rm x`\n\n> **Run** `rm x`\n\n");
  });

  test("reports other failures with the first line of the error", () => {
    const result = output(new TurnRenderer(cwd), [
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read" }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ type: "content", content: { type: "text", text: "ENOENT\nstack" } }] }),
    ]);
    expect(result).toBe("> **Read file**\n\n> ✗ **Read file** failed: ENOENT\n\n");
  });

  test("passes thoughts through as reasoning", () => {
    const renderer = new TurnRenderer(cwd);
    expect(renderer.handle(update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }))).toEqual([
      { reasoning_content: "hmm" },
    ]);
  });

  test("keeps the latest top-level usage and ignores subagent usage", () => {
    const renderer = new TurnRenderer(cwd);
    renderer.handle(update({ sessionUpdate: "usage_update", used: 10, size: 100, _meta: { "cognition.ai/inputTokens": 900, "cognition.ai/outputTokens": 40 } }));
    renderer.handle(update({ sessionUpdate: "usage_update", used: 5, size: 100, _meta: { "cognition.ai/inputTokens": 1, "cognition.ai/subagent_context": { parentAgentId: "root" } } }));
    expect(renderer.usage).toEqual({ promptTokens: 900, completionTokens: 40 });
  });

  test("keeps Devin's cache read count", () => {
    const renderer = new TurnRenderer(cwd);
    const meta = {
      "cognition.ai/inputTokens": 84577,
      "cognition.ai/outputTokens": 48,
      "cognition.ai/cachedReadTokens": 10759,
      "cognition.ai/cachedWriteTokens": 20932,
    };
    renderer.handle(update({ sessionUpdate: "usage_update", used: 84625, size: 1000000, _meta: meta }));
    expect(renderer.usage).toEqual({ promptTokens: 84577, completionTokens: 48, cachedTokens: 10759 });
  });

  test("keeps paths outside the working directory absolute", () => {
    const result = output(new TurnRenderer(cwd), [
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", locations: [{ path: "/etc/hosts" }] }),
    ]);
    expect(result).toBe("> **Read file** `/etc/hosts`\n\n");
  });
});

describe("TurnRenderer with tool cards", () => {
  test("holds a tool back until it finishes, then hands it out as a card instead of markdown", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    const before = [
      text("Checking."),
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran git", kind: "execute", rawInput: { command: "git status --short" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: " M src/a.ts" } }], _meta: { terminal_exit: { exit_code: 1 } } }),
    ].flatMap((event) => renderer.handle(event));
    expect(before.map((delta) => delta.content).join("")).toBe("Checking.");
    expect(renderer.takeCard()).toBeUndefined();
    renderer.handle(update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }));
    expect(renderer.takeCard()).toEqual({ title: "Run git status --short", output: "M src/a.ts\n\nExit code 1" });
    expect(renderer.takeCard()).toBeUndefined();
  });

  test("puts an edit's diff in the card output, with paths relative to the working directory", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit file", kind: "edit", locations: [{ path: "/work/app/a.txt" }], content: [{ type: "diff", path: "/work/app/a.txt", oldText: "x\n", newText: "y\n" }] }));
    renderer.handle(update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }));
    expect(renderer.takeCard()).toEqual({ title: "Edit file a.txt", output: "a.txt\n@@ -1,1 +1,1 @@\n-x\n+y" });
  });

  test("renders tools that never finished as markdown at the end of the turn", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read" }));
    expect(renderer.finish().map((delta) => delta.content).join("")).toBe("> **Read file**\n\n");
  });
});
