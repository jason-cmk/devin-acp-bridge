import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/** Set by the OpenCode plugin on every request to the Devin provider. */
export const AGENT_HEADER = "x-opencode-agent";

/**
 * `build` maps to `accept-edits`, not `bypass`, so its tool calls still go through the policy file and the user.
 * Keep the explicit entry: an unmapped agent returns to the starting mode only when Devin reported one.
 * `devin-bypass` is the only route to `bypass`: Devin then sends no permission requests, so the policy file,
 * the chained-command guard and permission prompts do not apply. Users opt in by defining that agent.
 */
export const BYPASS_AGENT = "devin-bypass";

const AGENT_MODES = new Map([
  ["build", "accept-edits"],
  ["plan", "plan"],
  [BYPASS_AGENT, "bypass"],
]);

/** Agents without a mode use the mode the Devin session started with. */
export function devinModeFor(agent: string | null | undefined): string | undefined {
  return agent ? AGENT_MODES.get(agent) : undefined;
}

export function initialMode(configOptions: SessionConfigOption[] | null | undefined): string | undefined {
  const current = (configOptions?.find((option) => option.id === "mode") as { currentValue?: unknown } | undefined)?.currentValue;
  return typeof current === "string" ? current : undefined;
}
