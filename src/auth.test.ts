import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuthorized, resolveToken } from "./auth";

describe("resolveToken", () => {
  const dir = mkdtempSync(join(tmpdir(), "devin-acp-bridge-auth-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("prefers DEVIN_BRIDGE_TOKEN", () => {
    expect(resolveToken({ DEVIN_BRIDGE_TOKEN: " abc " }, join(dir, "unused"))).toEqual({ value: "abc", source: "env" });
  });

  test("creates a private token file once and then reuses it", () => {
    const path = join(dir, "nested", "token");
    const first = resolveToken({}, path);
    expect(first.source).toBe("file");
    expect(first.value).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(resolveToken({}, path).value).toBe(first.value);
  });
});

describe("isAuthorized", () => {
  test("accepts the exact bearer token", () => {
    expect(isAuthorized("Bearer secret", "secret")).toBe(true);
  });

  test.each([null, "", "secret", "Bearer secre", "Bearer secret2", "Basic secret"])("rejects %p", (header) => {
    expect(isAuthorized(header, "secret")).toBe(false);
  });
});
