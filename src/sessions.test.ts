import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "./openai";
import { latestUserImages, SessionStore, sessionKey, transcriptPrompt } from "./sessions";

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
