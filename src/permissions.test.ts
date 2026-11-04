import { afterAll, describe, expect, test } from "bun:test";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePermission, loadPolicy, matchRule, permissionLabel, type PolicyRule } from "./permissions";

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
    expect(decidePermission(commandRequest("git push origin main", "Exec(git)"), rules).allowed).toBe(false);
  });

  test("matches on Devin's permission rule", () => {
    expect(decidePermission(commandRequest("dotnet build", "Exec(dotnet)"), rules).allowed).toBe(true);
  });

  test("rejects a command that no rule matches", () => {
    expect(decidePermission(commandRequest("rm -rf /", "Exec(rm)"), rules).response).toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });
  });

  test("treats glob metacharacters other than * literally", () => {
    expect(matchRule([{ command: "ls (a)", decision: "allow" }], commandRequest("ls (a)", "Exec(ls)"))).toBeDefined();
    expect(matchRule([{ command: "ls .", decision: "allow" }], commandRequest("ls x", "Exec(ls)"))).toBeUndefined();
  });

  test.each(["git status && rm -rf ~", "git log; rm x", "git log | sh", "git log > /etc/x", "git $(rm x)", "git `rm x`", "git log\nrm x"])(
    "does not let an allow rule cover chained command %p",
    (command) => {
      expect(decidePermission(commandRequest(command, "Exec(git)"), rules).allowed).toBe(false);
    },
  );

  test("ignores a rule with no match fields", () => {
    expect(matchRule([{ decision: "allow" }], commandRequest("anything", "Exec(any)"))).toBeUndefined();
  });

  test("rejects when an allow rule matches but Devin offers no allow_once option", () => {
    const request = { ...commandRequest("git status", "Exec(git)"), options: devinOptions.filter((o) => o.kind !== "allow_once") };
    expect(decidePermission(request, rules).allowed).toBe(false);
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
    expect(decision).toEqual({ response: { outcome: { outcome: "selected", optionId: "reject" } }, allowed: false });
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
    expect(decision).toEqual({ response: { outcome: { outcome: "cancelled" } }, allowed: false });
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
