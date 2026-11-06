import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TurnEvent } from "./devin";
import type { Delta } from "./openai";
import { CardStore, cardToolCall, todoToolCall, type ToolCard, TurnRenderer } from "./render";

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
  const finish = (renderer: TurnRenderer, toolCallId = "t1") =>
    renderer.handle(update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" }));

  test("holds a shell command back until it finishes, then hands it out as an OpenCode shell card", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    const before = [
      text("Checking."),
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran git", kind: "execute", rawInput: { command: "git status --short", workdir: "/work/app/sub" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: " M src/a.ts" } }], _meta: { terminal_exit: { exit_code: 1 } } }),
    ].flatMap((event) => renderer.handle(event));
    expect(before.map((delta) => delta.content).join("")).toBe("Checking.");
    expect(renderer.takeCard()).toBeUndefined();
    finish(renderer);
    expect(renderer.takeCard()).toEqual({
      title: "Run git status --short",
      tool: "shell",
      input: { command: "git status --short", workdir: "sub" },
      output: "M src/a.ts",
      metadata: { exit: 1, truncated: false },
    });
    expect(renderer.takeCard()).toBeUndefined();
  });

  test("hands out an edit as an OpenCode edit card with the diff in the metadata", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit file", kind: "edit", locations: [{ path: "/work/app/a.txt" }], content: [{ type: "diff", path: "/work/app/a.txt", oldText: "x\n", newText: "y\n" }] }));
    finish(renderer);
    expect(renderer.takeCard()).toEqual({
      title: "Edit file a.txt",
      tool: "edit",
      input: { path: "a.txt" },
      output: "Edited a.txt",
      metadata: { files: [{ file: "a.txt", patch: "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-x\n+y", status: "modified", additions: 1, deletions: 1 }], truncated: false },
    });
  });

  test("hands out edits of several files, or of a new file, as an OpenCode patch card", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit files", kind: "edit", content: [
      { type: "diff", path: "/work/app/a.txt", oldText: "x\n", newText: "y\n" },
      { type: "diff", path: "/work/app/b.txt", oldText: null, newText: "new\n" },
    ] }));
    finish(renderer);
    const card = renderer.takeCard()!;
    expect(card.tool).toBe("patch");
    expect(card.output).toBe("Edited a.txt\nCreated b.txt");
    expect((card.metadata.files as Array<{ status: string }>).map((file) => file.status)).toEqual(["modified", "added"]);
  });

  test("hands out a read, a search and a web search with the inputs of OpenCode's tools", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "r", title: "Read file", kind: "read", rawInput: { file_path: "/work/app/src/a.ts", offset: 20, limit: 60 } }));
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "s", title: "Search for 'foo'", kind: "search", rawInput: { query: "foo", path: "/work/app/src", file_pattern: "*.ts" } }));
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "w", title: "Searched web for bun", kind: "fetch", rawInput: { query: "bun", num_results: 5 } }));
    ["r", "s", "w"].forEach((id) => finish(renderer, id));
    expect([renderer.takeCard(), renderer.takeCard(), renderer.takeCard()].map((card) => [card?.tool, card?.input])).toEqual([
      ["read", { path: "src/a.ts", offset: 20, limit: 60 }],
      ["grep", { pattern: "foo", path: "src", include: "*.ts" }],
      ["websearch", { query: "bun" }],
    ]);
  });

  test("names other tools as Devin does, with MCP tools in OpenCode's `<server>_<tool>` form", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "m", title: "Calling execute_sql from bq", rawInput: { sql: "SELECT 1\nFROM t", nested: { a: 1 } }, _meta: { "cognition.ai/inferenceToolName": "mcp__bq__execute_sql" } }));
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "k", title: "Kill shell", rawInput: { shell_id: "9ba78e" }, _meta: { "cognition.ai/inferenceToolName": "kill_shell" } }));
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "q", title: "Asked user", rawInput: { questions: [] }, _meta: { "cognition.ai/inferenceToolName": "question" } }));
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "t", title: "Thinking", kind: "think" }));
    ["m", "k", "q", "t"].forEach((id) => finish(renderer, id));
    expect([1, 2, 3, 4].map(() => renderer.takeCard()).map((card) => [card?.tool, card?.input])).toEqual([
      ["bq_execute_sql", { sql: "SELECT 1" }],
      ["kill_shell", { shell_id: "9ba78e" }],
      ["devin_question", {}],
      ["think", {}],
    ]);
  });

  test("shows a card as markdown, with shell output, diffs and a non-zero exit code", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    const shell = renderer.cardMarkdown({ title: "Run false", tool: "shell", input: { command: "false" }, output: "oops", metadata: { exit: 1 } });
    expect(shell.map((delta) => delta.content).join("")).toBe("> **Run false**\n\n```text\noops\n```\n\n> ✗ exited with code 1\n\n");
    const edit = renderer.cardMarkdown({ title: "Edit file a.txt", tool: "edit", input: { path: "a.txt" }, output: "Edited a.txt", metadata: { files: [{ file: "a.txt", patch: "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-x\n+y", status: "modified", additions: 1, deletions: 1 }] } });
    expect(edit.map((delta) => delta.content).join("")).toBe("> **Edit file a.txt**\n\n`a.txt`\n\n```diff\n@@ -1 +1 @@\n-x\n+y\n```\n\n");
  });

  test("renders tools that never finished as markdown at the end of the turn", () => {
    const renderer = new TurnRenderer(cwd, { cards: true });
    renderer.handle(update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read" }));
    expect(renderer.finish().map((delta) => delta.content).join("")).toBe("> **Read file**\n\n");
  });
});

const card = (title: string): ToolCard => ({ title, tool: "read", input: { path: title }, output: "", metadata: {} });

describe("cardToolCall", () => {
  test("names the OpenCode tool that draws the card and sends that tool's input", () => {
    const call = cardToolCall("devincard_1", { title: "Run git status", tool: "shell", input: { command: "git status" }, output: "M a.ts", metadata: { exit: 0 } });
    expect(call).toEqual({ id: "devincard_1", type: "function", function: { name: "shell", arguments: '{"command":"git status"}' } });
  });
});

describe("CardStore", () => {
  test("returns a card by call ID", () => {
    const store = new CardStore();
    store.put("call_1", card("x"));
    expect(store.get("call_1")).toEqual(card("x"));
    expect(store.get("call_2")).toBeUndefined();
  });

  test("keeps only the newest cards", () => {
    const store = new CardStore(2);
    store.put("a", card("a"));
    store.put("b", card("b"));
    store.put("c", card("c"));
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")?.title).toBe("b");
    expect(store.get("c")?.title).toBe("c");
  });
});

describe("todo mode", () => {
  test("queues each changed plan for the todo tool and renders no plan markdown", () => {
    const renderer = new TurnRenderer(cwd, { todos: true });
    const plan = { sessionUpdate: "plan", entries: [{ content: "Alpha", status: "in_progress", priority: "medium" }] } as SessionUpdate;
    expect(renderer.handle({ kind: "update", update: plan })).toEqual([]);
    expect(renderer.handle({ kind: "update", update: plan })).toEqual([]);
    expect(renderer.takeTodos()).toEqual([{ content: "Alpha", status: "in_progress", priority: "medium" }]);
    expect(renderer.takeTodos()).toBeUndefined();
    expect(renderer.finish().map((delta) => delta.content ?? "").join("")).not.toContain("**Plan**");
  });

  test("todoToolCall sends content and status only", () => {
    const call = todoToolCall("call_t", [{ content: "Alpha", status: "completed", priority: "high" }]);
    expect(call.function).toEqual({ name: "todowrite", arguments: '{"todos":[{"content":"Alpha","status":"completed"}]}' });
  });
});
