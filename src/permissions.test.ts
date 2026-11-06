import { afterAll, describe, expect, test } from "bun:test";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPolicyRule,
  allowOnceResponse,
  alwaysAllowRule,
  PERMISSION_ALWAYS,
  decidePermission,
  loadPolicy,
  matchRule,
  nativePermission,
  nativePermissionAnswer,
  PERMISSION_NATIVE_ALWAYS,
  permissionToolCall,
  PERMISSION_ALLOW,
  PERMISSION_REJECT,
  permissionLabel,
  permissionQuestion,
  type PolicyRule,
} from "./permissions";

function requestWith(options: PermissionOption[]): RequestPermissionRequest {
  return { sessionId: "s1", toolCall: { toolCallId: "t1", title: "rm -rf build" }, options };
}

const devinOptions: PermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "switch_bypass", name: "Yes, switch to bypass mode", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

function commandRequest(command: string, rule: string): RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", _meta: { "cognition.ai/editableCommand": command, "cognition.ai/permissionRule": rule } },
    options: devinOptions,
  };
}

describe("policy rules", () => {
  const rules: PolicyRule[] = [
    { command: "git push*", decision: "reject" },
    { command: "git *", decision: "allow" },
    { rule: "Exec(dotnet)", decision: "allow" },
  ];

  test("allows a matching command once, never permanently", () => {
    expect(decidePermission(commandRequest("git status --short", "Exec(git)"), rules)).toEqual({
      response: { outcome: { outcome: "selected", optionId: "allow_once" } },
      allowed: true,
    });
  });

  test("applies the first matching rule", () => {
    const decision = decidePermission(commandRequest("git push origin main", "Exec(git)"), rules);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("reject rule");
  });

  test("matches on Devin's permission rule", () => {
    expect(decidePermission(commandRequest("dotnet build", "Exec(dotnet)"), rules).allowed).toBe(true);
  });

  test("rejects a command that no rule matches, and lets the user decide instead", () => {
    expect(decidePermission(commandRequest("rm -rf /", "Exec(rm)"), rules)).toEqual({
      response: { outcome: { outcome: "selected", optionId: "reject_once" } },
      allowed: false,
      reason: "no matching rule",
      askable: true,
    });
  });

  test("never lets the user decide a request that a reject rule matches", () => {
    expect(decidePermission(commandRequest("git push origin main", "Exec(git)"), rules).askable).toBeUndefined();
  });

  test("lets the user decide a chained command", () => {
    expect(decidePermission(commandRequest("git status && rm -rf ~", "Exec(git)"), rules).askable).toBe(true);
  });

  test("does not let the user decide when Devin offers no allow_once option", () => {
    const request = { ...commandRequest("rm x", "Exec(rm)"), options: devinOptions.filter((o) => o.kind !== "allow_once") };
    expect(decidePermission(request, rules).askable).toBeUndefined();
  });

  test("treats glob metacharacters other than * literally", () => {
    expect(matchRule([{ command: "ls (a)", decision: "allow" }], commandRequest("ls (a)", "Exec(ls)"))).toBeDefined();
    expect(matchRule([{ command: "ls .", decision: "allow" }], commandRequest("ls x", "Exec(ls)"))).toBeUndefined();
  });

  test.each(["git status && rm -rf ~", "git log; rm x", "git log | sh", "git log > /etc/x", "git $(rm x)", "git `rm x`", "git log\nrm x"])(
    "does not let an allow rule cover chained command %p",
    (command) => {
      const decision = decidePermission(commandRequest(command, "Exec(git)"), rules);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("chained command");
    },
  );

  test("ignores a rule with no match fields", () => {
    expect(matchRule([{ decision: "allow" }], commandRequest("anything", "Exec(any)"))).toBeUndefined();
  });

  test("rejects when an allow rule matches but Devin offers no allow_once option", () => {
    const request = { ...commandRequest("git status", "Exec(git)"), options: devinOptions.filter((o) => o.kind !== "allow_once") };
    const decision = decidePermission(request, rules);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no allow-once option");
  });
});

describe("loadPolicy", () => {
  const dir = mkdtempSync(join(tmpdir(), "devin-acp-bridge-policy-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("returns no rules for a missing file", () => {
    expect(loadPolicy(join(dir, "missing.json"))).toEqual([]);
  });

  test("returns no rules for invalid JSON", () => {
    const path = join(dir, "invalid.json");
    writeFileSync(path, "{ not json");
    expect(loadPolicy(path)).toEqual([]);
  });

  test("drops rules without a valid decision", () => {
    const path = join(dir, "policy.json");
    writeFileSync(path, JSON.stringify({ rules: [{ command: "git *", decision: "allow" }, { command: "x", decision: "yes" }] }));
    expect(loadPolicy(path)).toEqual([{ command: "git *", decision: "allow" }]);
  });
});

describe("decidePermission", () => {
  test("selects reject_once even when an allow option comes first", () => {
    const decision = decidePermission(
      requestWith([
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ]),
    );
    expect(decision).toEqual({ response: { outcome: { outcome: "selected", optionId: "reject" } }, allowed: false, reason: "no matching rule", askable: true });
  });

  test("falls back to reject_always", () => {
    const decision = decidePermission(
      requestWith([
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "never", name: "Never", kind: "reject_always" },
      ]),
    );
    expect(decision.response).toEqual({ outcome: { outcome: "selected", optionId: "never" } });
  });

  test("cancels when no reject option exists", () => {
    const decision = decidePermission(requestWith([{ optionId: "allow", name: "Allow", kind: "allow_once" }]));
    expect(decision).toEqual({ response: { outcome: { outcome: "cancelled" } }, allowed: false, reason: "no matching rule", askable: true });
  });

  test("never picks switch_bypass, which Devin offers as an allow_always option", () => {
    const decision = decidePermission(
      requestWith([
        { optionId: "switch_bypass", name: "Yes, switch to bypass mode", kind: "allow_always" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ]),
    );
    expect(decision.response).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
  });
});

describe("permissionQuestion", () => {
  test("shows the full command, the tool kind, Devin's rule and why no rule allowed it", () => {
    const request: RequestPermissionRequest = {
      ...commandRequest("git status && rm -rf ~", "Exec(git)"),
      toolCall: { toolCallId: "t1", kind: "execute", _meta: { "cognition.ai/editableCommand": "git status && rm -rf ~", "cognition.ai/permissionRule": "Exec(git)" } },
    };
    expect(permissionQuestion(request, "chained command")).toEqual({
      question: "Allow Devin to use `git status && rm -rf ~`? Tool: execute. Devin rule: Exec(git). Bridge policy: chained command.",
      header: "Permission",
      options: [
        { label: PERMISSION_ALLOW, description: "Allow this call only." },
        { label: PERMISSION_REJECT, description: "Devin tells its model that you rejected the call." },
      ],
    });
  });

  test("lists the paths of a file tool and leaves out missing details", () => {
    const request: RequestPermissionRequest = {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Edit file", kind: "edit", locations: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }] },
      options: devinOptions,
    };
    expect(permissionQuestion(request, "no matching rule").question).toBe(
      "Allow Devin to use `Edit file`? Paths: /repo/a.ts, /repo/b.ts. Tool: edit. Bridge policy: no matching rule.",
    );
  });
});

describe("alwaysAllowRule", () => {
  test("is an exact command rule for a plain command that no rule matched", () => {
    expect(alwaysAllowRule(commandRequest("npm test", "Exec(npm)"), "no matching rule")).toEqual({ command: "npm test", decision: "allow" });
  });

  test("is not offered for chained commands, globs, other reasons or requests without a command", () => {
    expect(alwaysAllowRule(commandRequest("git status && rm -rf ~", "Exec(git)"), "chained command")).toBeUndefined();
    expect(alwaysAllowRule(commandRequest("ls *.ts", "Exec(ls)"), "no matching rule")).toBeUndefined();
    expect(alwaysAllowRule(commandRequest("npm test", "Exec(npm)"), "reject rule")).toBeUndefined();
    expect(alwaysAllowRule(requestWith(devinOptions), "no matching rule")).toBeUndefined();
  });

  test("adds a third prompt option only when a rule can be saved", () => {
    const labels = (request: RequestPermissionRequest, reason: "no matching rule" | "chained command") =>
      permissionQuestion(request, reason).options.map((option) => option.label);
    expect(labels(commandRequest("npm test", "Exec(npm)"), "no matching rule")).toEqual([PERMISSION_ALLOW, PERMISSION_ALWAYS, PERMISSION_REJECT]);
    expect(labels(commandRequest("a && b", "Exec(a)"), "chained command")).toEqual([PERMISSION_ALLOW, PERMISSION_REJECT]);
  });
});

describe("addPolicyRule", () => {
  const dir = mkdtempSync(join(tmpdir(), "devin-acp-bridge-add-rule-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("creates the file and its folder when they are missing", () => {
    const path = join(dir, "new", "policy.json");
    addPolicyRule({ command: "npm test", decision: "allow" }, path);
    expect(loadPolicy(path)).toEqual([{ command: "npm test", decision: "allow" }]);
  });

  test("appends to the existing rules and keeps other keys", () => {
    const path = join(dir, "policy.json");
    writeFileSync(path, JSON.stringify({ note: "mine", rules: [{ command: "git *", decision: "reject" }] }));
    addPolicyRule({ command: "npm test", decision: "allow" }, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      note: "mine",
      rules: [{ command: "git *", decision: "reject" }, { command: "npm test", decision: "allow" }],
    });
  });

  test("refuses to overwrite a file it cannot parse", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    expect(() => addPolicyRule({ command: "npm test", decision: "allow" }, path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("allowOnceResponse", () => {
  test("selects allow_once and never an allow_always option", () => {
    expect(allowOnceResponse(requestWith(devinOptions))).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });
});

describe("permissionLabel", () => {
  test("prefers the tool call title", () => {
    expect(permissionLabel(requestWith([]))).toBe("`rm -rf build`");
  });

  test("uses Devin's editable command when there is no title", () => {
    const request: RequestPermissionRequest = {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", _meta: { "cognition.ai/editableCommand": "touch /tmp/x", "cognition.ai/permissionRule": "Exec(touch)" } },
      options: [],
    };
    expect(permissionLabel(request)).toBe("`touch /tmp/x`");
  });

  test("falls back to a generic label", () => {
    expect(permissionLabel({ sessionId: "s1", toolCall: { toolCallId: "t1" }, options: [] })).toBe("tool call");
  });
});

describe("nativePermission", () => {
  const request = (meta: Record<string, string>): RequestPermissionRequest => ({
    sessionId: "s",
    toolCall: { toolCallId: "t", _meta: meta },
    options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
  });

  test("shows a plain command as a shell command that Always can save", () => {
    expect(nativePermission(request({ "cognition.ai/editableCommand": "git status" }), "no matching rule")).toEqual({
      title: "Run git status", action: "bash", resources: ["git status"], save: ["git status"], chained: false,
    });
  });

  test("never offers Always for a chained command", () => {
    const check = nativePermission(request({ "cognition.ai/editableCommand": "git status && rm -rf ~" }), "chained command");
    expect(check.save).toEqual([]);
    expect(check.chained).toBe(true);
  });

  test("names an MCP tool as the action", () => {
    expect(nativePermission(request({ "cognition.ai/permissionRule": "mcp__slack__slack_read_channel" }), "no matching rule")).toEqual({
      title: "Use mcp__slack__slack_read_channel", action: "mcp__slack__slack_read_channel", resources: ["*"], save: ["*"], chained: false,
    });
  });

  test("falls back to devin-other with no Always", () => {
    const check = nativePermission(request({ "cognition.ai/permissionRule": "Read(/etc/hosts)" }), "no matching rule");
    expect(check).toEqual({ title: "Allow Read(/etc/hosts)", action: "devin-other", resources: ["Read(/etc/hosts)"], save: [], chained: false });
  });

  test("sends only the title in the tool call", () => {
    const call = permissionToolCall("call_1", nativePermission(request({ "cognition.ai/editableCommand": "ls" }), "no matching rule"));
    expect(call.function).toEqual({ name: "permission", arguments: '{"title":"Run ls"}' });
  });

  test("maps the tool result to an answer", () => {
    expect(nativePermissionAnswer("ALLOWED")).toEqual([[PERMISSION_ALLOW]]);
    expect(nativePermissionAnswer(" ALLOWED_ALWAYS\n")).toEqual([[PERMISSION_NATIVE_ALWAYS]]);
    expect(nativePermissionAnswer("The user rejected permission to use this specific tool call.")).toBeUndefined();
  });
});
