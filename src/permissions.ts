import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { globMatches } from "./glob";

export type PermissionDecision = { response: RequestPermissionResponse; allowed: boolean };

/** Glob patterns (`*` matches anything) against Devin's command, permission rule and tool title. */
export type PolicyRule = { command?: string; rule?: string; title?: string; decision: "allow" | "reject" };

export const defaultPolicyPath = process.env.DEVIN_BRIDGE_POLICY ?? join(homedir(), ".config", "devin-acp-bridge", "policy.json");

function metaString(request: RequestPermissionRequest, key: string): string | undefined {
  const value = request.toolCall._meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Devin sends permission requests without a `title`; the command or rule is only in its `_meta`. */
export function permissionLabel(request: RequestPermissionRequest): string {
  const label = request.toolCall.title
    || metaString(request, "cognition.ai/editableCommand")
    || metaString(request, "cognition.ai/permissionRule");
  return label ? `\`${label}\`` : "tool call";
}

export function matchRule(rules: PolicyRule[], request: RequestPermissionRequest): PolicyRule | undefined {
  const command = metaString(request, "cognition.ai/editableCommand");
  const rule = metaString(request, "cognition.ai/permissionRule");
  return rules.find((candidate) =>
    (candidate.command !== undefined || candidate.rule !== undefined || candidate.title !== undefined)
    && (candidate.command === undefined || globMatches(candidate.command, command))
    && (candidate.rule === undefined || globMatches(candidate.rule, rule))
    && (candidate.title === undefined || globMatches(candidate.title, request.toolCall.title)));
}

/** A missing file means no rules. An unreadable or invalid file also means no rules, so everything is rejected. */
export function loadPolicy(path = defaultPolicyPath): PolicyRule[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { rules?: unknown };
    if (!Array.isArray(parsed.rules)) throw new Error("expected { \"rules\": [...] }");
    return parsed.rules.filter((rule): rule is PolicyRule =>
      typeof rule === "object" && rule !== null && ["allow", "reject"].includes((rule as PolicyRule).decision));
  } catch (error) {
    console.error(`Ignoring invalid permission policy ${path}: ${(error as Error).message}`);
    return [];
  }
}

/** A glob such as `git *` would otherwise also allow `git status && rm -rf ~`. */
const SHELL_OPERATORS = /[;&|<>`\n]|\$\(/;

/**
 * Allows only through an explicit `allow` rule, and then only once: Devin also offers persistent allows and
 * `switch_bypass` as `allow_always` options, which the bridge must never pick. Everything else is rejected.
 */
export function decidePermission(request: RequestPermissionRequest, rules: PolicyRule[] = []): PermissionDecision {
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  const command = metaString(request, "cognition.ai/editableCommand") ?? "";
  if (matchRule(rules, request)?.decision === "allow" && allowOnce && !SHELL_OPERATORS.test(command)) {
    return { response: { outcome: { outcome: "selected", optionId: allowOnce.optionId } }, allowed: true };
  }
  const reject = request.options.find((option) => option.kind === "reject_once")
    ?? request.options.find((option) => option.kind === "reject_always");
  return reject
    ? { response: { outcome: { outcome: "selected", optionId: reject.optionId } }, allowed: false }
    : { response: { outcome: { outcome: "cancelled" } }, allowed: false };
}
