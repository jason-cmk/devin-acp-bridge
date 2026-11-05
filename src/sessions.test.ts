import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "./openai";
import { compactionSummary, latestUserImages, SessionStore, sessionKey, transcriptPrompt } from "./sessions";

describe("latestUserImages", () => {
  test("takes images from the newest non-harness user message only", () => {
    const image = (data: string) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } });
    const request: ChatRequest = {
      messages: [
        { role: "user", content: [{ type: "text", text: "old" }, image("OLD")] },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text: "new" }, image("NEW")] },
        { role: "user", content: "<system-reminder>\nharness\n</system-reminder>" },
      ],
    };
    expect(latestUserImages(request)).toEqual([{ type: "image", mimeType: "image/png", data: "NEW" }]);
  });
});

function conversation(...turns: string[]): ChatRequest {
  return {
    messages: [
      { role: "system", content: "harness prompt" },
      ...turns.map((content, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content })),
    ],
  };
}

describe("sessionKey", () => {
  test("uses the OpenCode session header when present", () => {
    expect(sessionKey("ses_1", conversation("hi"), "/a")).toBe("opencode:ses_1");
  });

  test("hashes the first user message and cwd when the header is missing", () => {
    const key = sessionKey(null, conversation("hi", "hello", "more"), "/a");
    expect(key).toBe(sessionKey(null, conversation("hi"), "/a"));
    expect(key).not.toBe(sessionKey(null, conversation("hi"), "/b"));
    expect(key).not.toBe(sessionKey(null, conversation("other"), "/a"));
  });
});

describe("SessionStore", () => {
  test("creates a session for the first turn with only the user message", () => {
    expect(new SessionStore().plan("k", conversation("hi"))).toEqual({ action: "create", prompt: "hi" });
  });

  test("reuses the session for the next turn and sends only the new message", () => {
    const store = new SessionStore();
    store.record("k", "devin-1", conversation("hi"));
    expect(store.plan("k", conversation("hi", "hello", "next"))).toEqual({ action: "reuse", sessionId: "devin-1", prompt: "next" });
  });

  test("starts a fresh session with the transcript when history was edited or retried", () => {
    const store = new SessionStore();
    store.record("k", "devin-1", conversation("hi", "hello", "next"));
    const retried = conversation("hi", "hello", "next again");
    expect(store.plan("k", retried)).toEqual({ action: "create", prompt: transcriptPrompt(retried) });
  });

  test("starts a fresh session with the transcript when the bridge has no entry for a later turn", () => {
    const request = conversation("hi", "hello", "next");
    expect(new SessionStore().plan("k", request)).toEqual({ action: "create", prompt: transcriptPrompt(request) });
  });
});

describe("OpenCode compaction", () => {
  const COMPACT = "You MUST summarize the conversation above into a structured summary that will be given to another agent.";
  const CHECKPOINT = "<conversation-checkpoint>\n<summary>\n## Objective\n- x\n</summary>\n</conversation-checkpoint>";
  /** What OpenCode sends after compaction: the checkpoint and the next message, both as user messages. */
  const afterCompaction = (next: string): ChatRequest => ({
    messages: [{ role: "system", content: "harness prompt" }, { role: "user", content: CHECKPOINT }, { role: "user", content: next }],
  });

  test("answers the compaction prompt locally and continues the same Devin session afterwards", () => {
    const store = new SessionStore();
    store.record("k", "devin-1", conversation("hi", "hello", "more"));
    expect(store.plan("k", conversation("hi", "hello", "more", "ok", COMPACT))).toEqual({ action: "compact", sessionId: "devin-1" });
    expect(store.plan("k", afterCompaction("next"))).toEqual({ action: "reuse", sessionId: "devin-1", prompt: "next" });
  });

  test("detects OpenCode's retry prompt for a reply that missed the template", () => {
    const store = new SessionStore();
    const retry = "The previous response did not fill in the required summary template. Do not call tools.";
    expect(store.plan("k", conversation("hi", "hello", COMPACT, "bad", retry))).toEqual({ action: "compact" });
  });

  test("replays the checkpoint into a fresh session when the bridge has no entry", () => {
    const store = new SessionStore();
    const after = afterCompaction("next");
    expect(store.plan("k", after)).toEqual({ action: "create", prompt: transcriptPrompt(after) });
  });

  test("the summary uses every heading of OpenCode's template and names the Devin session", () => {
    const summary = compactionSummary("devin-1");
    for (const heading of ["## Objective", "## Requirements", "## Decisions", "## Work State", "### Completed", "### Active", "### Blocked", "## Next Move", "## Relevant Files", "## Important Context"]) {
      expect(summary).toContain(`${heading}\n`);
    }
    expect(summary).toContain("`devin-1`");
  });
});

describe("OpenCode plan-agent reminders", () => {
  const reminder = { role: "user", content: "<system-reminder>\nYou are in Plan mode.\n</system-reminder>" };
  const withMessages = (...messages: ChatRequest["messages"] & object) => ({ messages: [{ role: "system", content: "harness" }, ...messages] });
  const first = withMessages(reminder, { role: "user", content: "hi" });
  const afterReply = withMessages({ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, reminder);

  test("does not send the reminder to Devin or count it as a turn", () => {
    const store = new SessionStore();
    expect(store.plan("k", first)).toEqual({ action: "create", prompt: "hi" });
    store.record("k", "devin-1", first);
    const next = withMessages({ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "next" }, reminder);
    expect(store.plan("k", next)).toEqual({ action: "reuse", sessionId: "devin-1", prompt: "next" });
  });

  test("skips a request whose only new user message is a reminder", () => {
    const store = new SessionStore();
    store.record("k", "devin-1", first);
    expect(store.plan("k", afterReply)).toEqual({ action: "skip" });
  });

  test("also treats OpenCode's tool-catalog update as harness text", () => {
    const update = { role: "user", content: [{ type: "text", text: "<system-update>\nThe Code Mode tool catalog has changed.\n</system-update>" }] };
    const request = withMessages({ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, update, reminder);
    expect(new SessionStore().plan("k", request)).toEqual({ action: "skip" });
  });

  test("keeps a user message that only starts with a system tag", () => {
    const request = withMessages({ role: "user", content: "<system-reminder>x</system-reminder> and my question" });
    expect(new SessionStore().plan("k", request)).toEqual({ action: "create", prompt: "<system-reminder>x</system-reminder> and my question" });
  });

  test("keys and replays the conversation without reminders", () => {
    expect(sessionKey(null, first, "/a")).toBe(sessionKey(null, afterReply, "/a"));
    const request = withMessages(reminder, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "next" });
    expect(transcriptPrompt(request)).toBe(transcriptPrompt(conversation("hi", "hello", "next")));
  });
});

describe("transcriptPrompt", () => {
  test("lists earlier turns without the system prompt and ends with the latest message", () => {
    expect(transcriptPrompt(conversation("hi", "hello", "next"))).toBe(
      [
        "This conversation started in another session. Earlier turns:",
        "",
        "<conversation>",
        "[user]\nhi\n\n[assistant]\nhello",
        "</conversation>",
        "",
        "Continue the conversation by answering this latest user message:",
        "",
        "next",
      ].join("\n"),
    );
  });
});
