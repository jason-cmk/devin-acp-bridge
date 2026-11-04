import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/** Set by the OpenCode plugin on every request to the Devin provider. */
export const AGENT_HEADER = "x-opencode-agent";

/** `bypass` means Devin sends no permission requests, so the bridge policy file does not apply to `build`. */
const AGENT_MODES = new Map([
  ["build", "bypass"],
  ["plan", "plan"],
]);

/** Agents without a mode use the mode the Devin session started with. */
export function devinModeFor(agent: string | null | undefined): string | undefined {
  return agent ? AGENT_MODES.get(agent) : undefined;
}

export function initialMode(configOptions: SessionConfigOption[] | null | undefined): string | undefined {
  const current = (configOptions?.find((option) => option.id === "mode") as { currentValue?: unknown } | undefined)?.currentValue;
  return typeof current === "string" ? current : undefined;
}
