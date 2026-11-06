import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { globMatches } from "./glob";

/** `thoughtLevels` and `defaultThoughtLevel` are known only after the bridge has probed the model (§6.10). */
export type DevinModel = { id: string; name: string; thoughtLevels?: string[]; defaultThoughtLevel?: string };
export type ModelCatalog = { defaultModel?: string; models: DevinModel[] };
export type ThoughtLevels = { levels: string[]; current?: string };

/** OpenCode's model ID for "whatever model Devin defaults to"; never sent to Devin. */
export const DEFAULT_MODEL_ID = "devin";
/** The plugin sets this header from the OpenCode model variant; the bridge applies it as Devin's `thought_level`. */
export const THOUGHT_HEADER = "x-devin-thought-level";

type SelectValue = { value: string; name: string };

function selectValues(option: SessionConfigOption): SelectValue[] {
  const entries = (option as { options?: unknown }).options;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) =>
    Array.isArray(entry?.options) ? entry.options : [entry],
  ).filter((entry): entry is SelectValue => typeof entry?.value === "string" && typeof entry?.name === "string");
}

/** Reads Devin's `model` config option. Each value already selects the model's default thought level. */
export function modelCatalog(configOptions: SessionConfigOption[] | null | undefined): ModelCatalog {
  const option = configOptions?.find((candidate) => candidate.id === "model");
  if (!option) return { models: [] };
  const current = (option as { currentValue?: unknown }).currentValue;
  return {
    defaultModel: typeof current === "string" ? current : undefined,
    models: sortModels(selectValues(option).map(({ value, name }) => ({ id: value, name }))),
  };
}

/** Devin's thought levels, lowest first. A model ID ends with its default level (`claude-opus-5-5-medium`). */
const LEVEL_RANK = ["minimal", "low", "medium", "high", "xhigh", "max"];
const nameOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function providerOf(id: string): string {
  return id.split("-")[0]!.toLowerCase();
}

function levelRankOf(id: string): number {
  const rank = LEVEL_RANK.indexOf(id.slice(id.lastIndexOf("-") + 1));
  return rank === -1 ? LEVEL_RANK.length : rank;
}

/**
 * Groups models by provider (the first part of the ID), providers A–Z. In a group, names sort A–Z with numbers
 * compared as numbers, so `GPT-5.6` comes before `GPT-6`. Models with the same name sort by level, low to high.
 */
export function sortModels(models: DevinModel[]): DevinModel[] {
  return [...models].sort(
    (a, b) =>
      providerOf(a.id).localeCompare(providerOf(b.id)) ||
      nameOrder.compare(a.name, b.name) ||
      levelRankOf(a.id) - levelRankOf(b.id) ||
      a.id.localeCompare(b.id),
  );
}

/** OpenCode reports the variant `default` when the user picked none; that means the model's own level. */
export function thoughtLevelFor(variant: string | null | undefined): string | undefined {
  return variant && variant !== "default" ? variant : undefined;
}

/** Devin's `thought_level` option for the session's current model. Its values change with the model. */
export function thoughtLevels(configOptions: SessionConfigOption[] | null | undefined): ThoughtLevels {
  const option = configOptions?.find((candidate) => candidate.id === "thought_level");
  if (!option) return { levels: [] };
  const current = (option as { currentValue?: unknown }).currentValue;
  return { levels: selectValues(option).map(({ value }) => value), ...(typeof current === "string" ? { current } : {}) };
}

export function filterModels(models: DevinModel[], exclude: string[]): DevinModel[] {
  return models.filter((model) => !exclude.some((pattern) => globMatches(pattern, model.id)));
}
