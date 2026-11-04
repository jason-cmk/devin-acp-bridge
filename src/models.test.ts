import { describe, expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { filterModels, modelCatalog } from "./models";

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

describe("filterModels", () => {
  test("drops models whose ID matches an exclude glob", () => {
    const { models } = modelCatalog(options);
    expect(filterModels(models, ["fusion-*"]).map((model) => model.id)).toEqual(["adaptive", "claude-opus-5-5-medium"]);
  });

  test("keeps everything with no exclude patterns", () => {
    expect(filterModels([{ id: "fusion-x", name: "X" }], [])).toHaveLength(1);
  });
});
