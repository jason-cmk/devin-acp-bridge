import { describe, expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { devinModeFor, initialMode } from "./modes";

describe("devinModeFor", () => {
  test("maps OpenCode's build agent to accept-edits and plan agent to plan", () => {
    expect(devinModeFor("build")).toBe("accept-edits");
    expect(devinModeFor("plan")).toBe("plan");
  });

  test.each([null, undefined, "", "devin", "constructor", "toString"])("has no mode for agent %p", (agent) => {
    expect(devinModeFor(agent)).toBeUndefined();
  });
});

describe("initialMode", () => {
  test("reads the current value of Devin's mode option", () => {
    const options = [
      { id: "mode", name: "Session Mode", type: "select", currentValue: "accept-edits", options: [] },
      { id: "model", name: "Model", type: "select", currentValue: "adaptive", options: [] },
    ] as unknown as SessionConfigOption[];
    expect(initialMode(options)).toBe("accept-edits");
  });

  test("returns undefined when Devin sends no mode option", () => {
    expect(initialMode(undefined)).toBeUndefined();
    expect(initialMode([])).toBeUndefined();
  });
});
