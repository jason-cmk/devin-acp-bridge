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
    models: selectValues(option).map(({ value, name }) => ({ id: value, name })),
  };
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
