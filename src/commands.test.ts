import { describe, expect, test } from "bun:test";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { bridgeCommands, commandPrompt } from "./commands";

const command = (name: string, category: string, hint?: string): AvailableCommand =>
  ({ name, description: `${name} description`, ...(hint ? { input: { hint } } : {}), _meta: { "cognition.ai/category": category } }) as AvailableCommand;

describe("bridgeCommands", () => {
  test("keeps session commands and skills that work through the bridge, with their input hint", () => {
    expect(
      bridgeCommands([
        command("compact", "Session"),
        command("recap", "Session"),
        command("tdd", "Skills"),
        command("agents:aws-cdk", "Skills", "[stack]"),
      ]),
    ).toEqual([
      { name: "compact", description: "compact description" },
      { name: "recap", description: "recap description" },
      { name: "tdd", description: "tdd description" },
      { name: "agents:aws-cdk", description: "agents:aws-cdk description", hint: "[stack]" },
    ]);
  });

  test("drops account and system commands, mode switches the agent already controls, and commands that need the Devin TUI", () => {
    const dropped = ["login", "billing", "mcp", "bug", "ask", "plan", "code", "smart", "bypass", "fast", "help", "share", "rename", "goal"];
    const categories: Record<string, string> = { login: "Account", billing: "Account", mcp: "System", bug: "System" };
    expect(bridgeCommands(dropped.map((name) => command(name, categories[name] ?? "Session")))).toEqual([]);
  });

  test("drops commands from unknown categories", () => {
    expect(bridgeCommands([command("new-thing", "Experimental")])).toEqual([]);
  });
});

describe("commandPrompt", () => {
  test("is the slash command with its arguments, as Devin reads it from the prompt", () => {
    expect(commandPrompt("compact", "")).toBe("/compact");
    expect(commandPrompt("agents:aws-cdk", "  my-stack ")).toBe("/agents:aws-cdk my-stack");
  });
});
