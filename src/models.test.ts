import { describe, expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { filterModels, modelCatalog, thoughtLevelFor, thoughtLevels } from "./models";

const options = [
  { id: "mode", name: "Session Mode", type: "select", currentValue: "accept-edits", options: [{ value: "accept-edits", name: "Code" }] },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "claude-opus-5-5-medium",
    options: [
      { value: "adaptive", name: "Adaptive" },
      { value: "claude-opus-5-5-medium", name: "Claude Opus 5.5" },
      { group: "fusion", name: "Fusion", options: [{ value: "fusion-a-sidekick-b", name: "Fusion A + B" }] },
    ],
  },
] as unknown as SessionConfigOption[];

describe("modelCatalog", () => {
  test("lists model values with display names, including grouped ones, and the current default", () => {
    expect(modelCatalog(options)).toEqual({
      defaultModel: "claude-opus-5-5-medium",
      models: [
        { id: "adaptive", name: "Adaptive" },
        { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5" },
        { id: "fusion-a-sidekick-b", name: "Fusion A + B" },
      ],
    });
  });

  test("returns an empty catalog when Devin sends no model option", () => {
    expect(modelCatalog(undefined)).toEqual({ models: [] });
  });
});

describe("thoughtLevels", () => {
  test("reads the allowed values and the current value of Devin's thought_level option", () => {
    const withThought = [
      ...options,
      { id: "thought_level", type: "select", currentValue: "high", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
    ] as unknown as SessionConfigOption[];
    expect(thoughtLevels(withThought)).toEqual({ levels: ["medium", "high"], current: "high" });
  });

  test("returns no levels when the model has none (adaptive)", () => {
    expect(thoughtLevels(options)).toEqual({ levels: [] });
  });
});

describe("thoughtLevelFor", () => {
  test("maps an OpenCode variant to a Devin thought level, and OpenCode's `default` variant to none", () => {
    expect(thoughtLevelFor("high")).toBe("high");
    expect(thoughtLevelFor("default")).toBeUndefined();
    expect(thoughtLevelFor(undefined)).toBeUndefined();
    expect(thoughtLevelFor("")).toBeUndefined();
  });
});

describe("filterModels", () => {
  test("drops models whose ID matches an exclude glob", () => {
    const { models } = modelCatalog(options);
    expect(filterModels(models, ["fusion-*"]).map((model) => model.id)).toEqual(["adaptive", "claude-opus-5-5-medium"]);
  });

  test("keeps everything with no exclude patterns", () => {
    expect(filterModels([{ id: "fusion-x", name: "X" }], [])).toHaveLength(1);
  });
});
