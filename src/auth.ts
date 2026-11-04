import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const defaultTokenPath = join(homedir(), ".config", "devin-acp-bridge", "token");

export type BridgeToken = { value: string; source: "env" | "file"; path?: string };

/** `DEVIN_BRIDGE_TOKEN` wins, because OpenCode reads the same variable. Otherwise a 0600 file is created once. */
export function resolveToken(env = process.env, path = defaultTokenPath): BridgeToken {
  const fromEnv = env.DEVIN_BRIDGE_TOKEN?.trim();
  if (fromEnv) return { value: fromEnv, source: "env" };
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  return { value: readFileSync(path, "utf8").trim(), source: "file", path };
}

export function isAuthorized(header: string | null, token: string): boolean {
  const presented = Buffer.from(header?.match(/^Bearer (.+)$/)?.[1] ?? "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
