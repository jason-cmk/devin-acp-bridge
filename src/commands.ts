import type { AvailableCommand } from "@agentclientprotocol/sdk";

export type DevinCommand = { name: string; description: string; hint?: string };

/** OpenCode command names are `devin:<name>`, so they never clash with OpenCode's own commands. */
export const COMMAND_PREFIX = "devin:";

const CATEGORIES = new Set(["Session", "Skills"]);
/**
 * Mode commands: the OpenCode agent picks Devin's mode (§6.11). `help`, `share`, `rename` and `fast` act on the
 * Devin TUI or its account. `goal` keeps Devin working after the turn ends, and the bridge drops that output.
 */
const EXCLUDED = new Set(["ask", "plan", "code", "smart", "bypass", "fast", "help", "share", "rename", "goal"]);

/** The Devin slash commands that make sense through the bridge (§6.15). */
export function bridgeCommands(available: AvailableCommand[]): DevinCommand[] {
  return available.flatMap((command) => {
    const category = command._meta?.["cognition.ai/category"];
    if (typeof category !== "string" || !CATEGORIES.has(category) || EXCLUDED.has(command.name)) return [];
    const hint = command.input && "hint" in command.input ? command.input.hint : undefined;
    return [{ name: command.name, description: command.description, ...(hint ? { hint } : {}) }];
  });
}

/** Devin reads a slash command from the start of the prompt text (ACP `available_commands_update`). */
export function commandPrompt(name: string, args: string): string {
  return args.trim() ? `/${name} ${args.trim()}` : `/${name}`;
}
