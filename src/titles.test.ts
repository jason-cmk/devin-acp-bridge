import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { devinTitle, TitleBoard } from "./titles";

const info = (title: string) => ({ sessionUpdate: "session_info_update", title }) as SessionUpdate;

describe("devinTitle", () => {
  const prompt = "Bridge test. Use no tools. Reply with exactly one word: the main colour of the image.";

  test("returns Devin's generated title", () => {
    expect(devinTitle(info("Identify the Attached Image’s Main Color"), prompt)).toBe("Identify the Attached Image’s Main Color");
  });

  test("ignores the clipped-prompt placeholder, also when the prompt is quoted", () => {
    expect(devinTitle(info("Bridge test. Use no tools. Reply with exactly one word: the main colour of t..."), prompt)).toBeUndefined();
    expect(devinTitle(info('"Bridge test. Use no tools..."'), `"${prompt}"`)).toBeUndefined();
    expect(devinTitle(info("Short prompt"), "Short prompt")).toBeUndefined();
  });

  test("ignores empty titles and other updates", () => {
    expect(devinTitle(info("  "), prompt)).toBeUndefined();
    expect(devinTitle({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }, prompt)).toBeUndefined();
  });
});

describe("TitleBoard", () => {
  test("resolves a waiting request when the title arrives", async () => {
    const board = new TitleBoard();
    const waiting = board.wait("k", 1000);
    board.offer("k", "A title");
    expect(await waiting).toBe("A title");
  });

  test("returns a title that arrived before the request", async () => {
    const board = new TitleBoard();
    board.offer("k", "Early");
    expect(await board.wait("k", 1000)).toBe("Early");
  });

  test("resolves undefined after the timeout", async () => {
    expect(await new TitleBoard().wait("k", 5)).toBeUndefined();
  });

  test("keeps keys apart", async () => {
    const board = new TitleBoard();
    const waiting = board.wait("a", 20);
    board.offer("b", "Other");
    expect(await waiting).toBeUndefined();
  });
});
