import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { globMatches } from "./glob";

export type DevinModel = { id: string; name: string };
export type ModelCatalog = { defaultModel?: string; models: DevinModel[] };

/** OpenCode's model ID for "whatever model Devin defaults to"; never sent to Devin. */
export const DEFAULT_MODEL_ID = "devin";

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

export function filterModels(models: DevinModel[], exclude: string[]): DevinModel[] {
  return models.filter((model) => !exclude.some((pattern) => globMatches(pattern, model.id)));
}
