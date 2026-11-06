import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { globMatches } from "./glob";
import type { ToolCall } from "./openai";
import type { OpenCodeQuestion } from "./questions";

export type RejectReason = "no matching rule" | "reject rule" | "chained command" | "no allow-once option";

/** `askable`: no rule decided the request, so the user may decide it instead of the default reject (§6.13). */
export type PermissionDecision = { response: RequestPermissionResponse; allowed: boolean; reason?: RejectReason; askable?: true };

export const PERMISSION_ALLOW = "Allow once";
export const PERMISSION_ALWAYS = "Always allow this command";
export const PERMISSION_REJECT = "Reject";
/** The answer for OpenCode's native "Always" (§6.17); never a label in the question. */
export const PERMISSION_NATIVE_ALWAYS = "Always (OpenCode)";

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
  const decision = matchRule(rules, request)?.decision;
  const chained = SHELL_OPERATORS.test(command);
  if (decision === "allow" && allowOnce && !chained) {
    return { response: { outcome: { outcome: "selected", optionId: allowOnce.optionId } }, allowed: true };
  }
  const reason: RejectReason = decision === undefined ? "no matching rule"
    : decision === "reject" ? "reject rule"
    : chained ? "chained command"
    : "no allow-once option";
  const reject = request.options.find((option) => option.kind === "reject_once")
    ?? request.options.find((option) => option.kind === "reject_always");
  const askable = allowOnce && (reason === "no matching rule" || reason === "chained command") ? { askable: true as const } : {};
  return reject
    ? { response: { outcome: { outcome: "selected", optionId: reject.optionId } }, allowed: false, reason, ...askable }
    : { response: { outcome: { outcome: "cancelled" } }, allowed: false, reason, ...askable };
}

/** The response for a user's "Allow once". Never an `allow_always` option, so never `switch_bypass`. */
export function allowOnceResponse(request: RequestPermissionRequest): RequestPermissionResponse {
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  return allowOnce ? { outcome: { outcome: "selected", optionId: allowOnce.optionId } } : { outcome: { outcome: "cancelled" } };
}

/**
 * The rule that "Always allow" saves: the exact command, and only for a plain command that no rule matched. A
 * chained command can never be allowed by a rule, and `*` in a command would become a glob.
 */
export function alwaysAllowRule(request: RequestPermissionRequest, reason: RejectReason): PolicyRule | undefined {
  const command = metaString(request, "cognition.ai/editableCommand");
  if (reason !== "no matching rule" || !command || command.includes("*") || SHELL_OPERATORS.test(command)) return undefined;
  return { command, decision: "allow" };
}

/** Appends a rule to the policy file. Throws, and leaves the file as it is, when the file is not valid policy JSON. */
export function addPolicyRule(rule: PolicyRule, path = defaultPolicyPath): void {
  let policy: { rules: unknown[]; [key: string]: unknown } = { rules: [] };
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { rules?: unknown };
    if (!Array.isArray(parsed.rules)) throw new Error("expected { \"rules\": [...] }");
    policy = parsed as typeof policy;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...policy, rules: [...policy.rules, rule] }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function permissionQuestion(request: RequestPermissionRequest, reason: RejectReason): OpenCodeQuestion {
  const paths = (request.toolCall.locations ?? []).map((location) => location.path);
  const rule = metaString(request, "cognition.ai/permissionRule");
  const details = [
    paths.length ? `Paths: ${paths.join(", ")}.` : undefined,
    request.toolCall.kind ? `Tool: ${request.toolCall.kind}.` : undefined,
    rule ? `Devin rule: ${rule}.` : undefined,
    `Bridge policy: ${reason}.`,
  ];
  return {
    question: [`Allow Devin to use ${permissionLabel(request)}?`, ...details].filter(Boolean).join(" "),
    header: "Permission",
    options: [
      { label: PERMISSION_ALLOW, description: "Allow this call only." },
      ...(alwaysAllowRule(request, reason)
        ? [{ label: PERMISSION_ALWAYS, description: "Allow now, and add an allow rule for this exact command to the bridge policy file." }]
        : []),
      { label: PERMISSION_REJECT, description: "Devin tells its model that you rejected the call." },
    ],
  };
}

/** The plugin registers this tool; its `execute` asks OpenCode's own permission system (§6.17). */
export const PERMISSION_TOOL = "permission";
/** The tool results that allow the call. Any other result, including an error, rejects it. */
export const PERMISSION_ALLOWED_RESULT = "ALLOWED";
/** The user chose "Always": allow, and save an exact-command allow rule to the bridge policy file. */
export const PERMISSION_ALLOWED_ALWAYS_RESULT = "ALLOWED_ALWAYS";

/**
 * A Devin permission request as an OpenCode permission check. `action` picks how OpenCode's dialog shows it:
 * `bash` shows "Shell command" and the command; an MCP rule name shows "Call tool <name>". OpenCode's `shell`
 * action is never used, so an agent that denies OpenCode's shell still asks for Devin's commands. The plugin turns
 * every `allow` for these checks into `ask` (§6.17). `save` is what OpenCode's "Always" offers: the exact
 * command, or nothing for a chained command, so `git status && rm -rf ~` never gets an "Always" option.
 */
export type NativePermission = { title: string; action: string; resources: string[]; save: string[]; chained: boolean };

export function nativePermission(request: RequestPermissionRequest, reason: RejectReason): NativePermission {
  const command = metaString(request, "cognition.ai/editableCommand");
  const rule = metaString(request, "cognition.ai/permissionRule");
  const label = permissionLabel(request).replace(/^`|`$/g, "");
  if (command) {
    const chained = SHELL_OPERATORS.test(command);
    const save = alwaysAllowRule(request, reason) ? [command] : [];
    return { title: `Run ${command.split("\n")[0]}`, action: "bash", resources: [command], save, chained };
  }
  if (rule?.startsWith("mcp__")) return { title: `Use ${rule}`, action: rule, resources: ["*"], save: ["*"], chained: false };
  const resource = rule ?? request.toolCall.title ?? label;
  return { title: `Allow ${resource}`, action: "devin-other", resources: [resource], save: [], chained: false };
}

export function permissionToolCall(callId: string, permission: NativePermission): ToolCall {
  return { id: callId, type: "function", function: { name: PERMISSION_TOOL, arguments: JSON.stringify({ title: permission.title }) } };
}

/** The `permission` tool result as the answer to the permission question: allow, always, or reject. */
export function nativePermissionAnswer(result: string): string[][] | undefined {
  const text = result.trim();
  if (text === PERMISSION_ALLOWED_ALWAYS_RESULT) return [[PERMISSION_NATIVE_ALWAYS]];
  if (text === PERMISSION_ALLOWED_RESULT) return [[PERMISSION_ALLOW]];
  return undefined;
}
