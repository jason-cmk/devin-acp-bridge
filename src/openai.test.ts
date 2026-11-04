import { describe, expect, test } from "bun:test";
import { finishReason, isTitleRequest, lastUserText, localTitle, messageImages, messageText, type ChatRequest } from "./openai";

const titleRequest: ChatRequest = {
  messages: [
    { role: "system", content: "You name conversations so the user can find them later." },
    {
      role: "user",
      content: 'Here is the first message of the conversation:\n\n<message>\n"show me the Handle method in SearchAllCustomerNotes"\n</message>\n\nReply with only the title.',
    },
  ],
};

describe("messageText", () => {
  test("returns string content as is", () => {
    expect(messageText({ role: "user", content: "hello" })).toBe("hello");
  });

  test("joins text parts and skips other part types", () => {
    expect(
      messageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }] }),
    ).toBe("a\nb");
  });

  test("returns empty text for null content", () => {
    expect(messageText({ role: "assistant", content: null })).toBe("");
  });
});

describe("messageImages", () => {
  test("turns base64 data URLs into ACP image blocks and skips other parts", () => {
    expect(
      messageImages({
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
          { type: "image_url", image_url: { url: "data:image/png,notbase64" } },
        ],
      }),
    ).toEqual([{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
  });

  test("returns no images for string content or a missing message", () => {
    expect(messageImages({ role: "user", content: "hi" })).toEqual([]);
    expect(messageImages(undefined)).toEqual([]);
  });
});

describe("lastUserText", () => {
  test("picks the newest user message", () => {
    expect(
      lastUserText({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "second" },
        ],
      }),
    ).toBe("second");
  });
});

describe("isTitleRequest", () => {
  test("detects OpenCode's title prompt", () => {
    expect(isTitleRequest(titleRequest)).toBe(true);
  });

  test("ignores a main chat request that has tools", () => {
    expect(isTitleRequest({ ...titleRequest, tools: [{}] })).toBe(false);
  });

  test("ignores a normal system prompt", () => {
    expect(isTitleRequest({ messages: [{ role: "system", content: "You are an AI agent running in OpenCode" }] })).toBe(false);
  });
});

describe("localTitle", () => {
  test("uses the first five words of the wrapped message without surrounding quotes", () => {
    expect(localTitle(titleRequest)).toBe("show me the Handle method");
  });

  test("falls back to a fixed title for an empty message", () => {
    expect(localTitle({ messages: [{ role: "user", content: "<message></message>" }] })).toBe("Devin session");
  });
});

describe("finishReason", () => {
  test.each([
    ["end_turn", "stop"],
    ["cancelled", "stop"],
    ["max_tokens", "length"],
    ["max_turn_requests", "length"],
    ["refusal", "content_filter"],
  ] as const)("maps %s to %s", (stopReason, expected) => {
    expect(finishReason(stopReason)).toBe(expected);
  });
});
