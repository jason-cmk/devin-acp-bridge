import { describe, expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { filterModels, modelCatalog, sortModels, thoughtLevelFor, thoughtLevels } from "./models";

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

describe("sortModels", () => {
  const ids = (models: { id: string }[]) => models.map((model) => model.id);

  test("groups models by provider, providers A-Z, and sorts names with numbers compared as numbers", () => {
    const models = [
      { id: "swe-2-high", name: "SWE-2" },
      { id: "gpt-6-1-sol-medium", name: "GPT-6.1 Sol" },
      { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5" },
      { id: "gpt-6-astra-medium", name: "GPT-6 Astra" },
      { id: "adaptive", name: "Adaptive" },
      { id: "gpt-5-6-terra-medium", name: "GPT-5.6 Terra" },
      { id: "claude-fable-5-1-medium", name: "Claude Fable 5.1" },
      { id: "swe-1-7-medium", name: "SWE-1.7" },
    ];
    expect(ids(sortModels(models))).toEqual([
      "adaptive",
      "claude-fable-5-1-medium",
      "claude-sonnet-5-5-medium",
      "gpt-5-6-terra-medium",
      "gpt-6-astra-medium",
      "gpt-6-1-sol-medium",
      "swe-1-7-medium",
      "swe-2-high",
    ]);
  });

  test("sorts models with the same name by thought level, low to high", () => {
    const models = ["max", "high", "low", "xhigh", "medium"].map((level) => ({ id: `claude-opus-5-5-${level}`, name: "Claude Opus 5.5" }));
    expect(ids(sortModels(models))).toEqual([
      "claude-opus-5-5-low",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-high",
      "claude-opus-5-5-xhigh",
      "claude-opus-5-5-max",
    ]);
  });

  test("does not change the list it is given", () => {
    const models = [{ id: "gpt-6-luna-medium", name: "GPT-6 Luna" }, { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5" }];
    sortModels(models);
    expect(ids(models)).toEqual(["gpt-6-luna-medium", "claude-opus-5-5-medium"]);
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
