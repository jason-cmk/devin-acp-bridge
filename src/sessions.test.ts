import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "./openai";
import { SessionStore, sessionKey, transcriptPrompt } from "./sessions";

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
