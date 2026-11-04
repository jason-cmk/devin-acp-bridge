import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const cacheDir = join(homedir(), ".cache", "devin-acp-bridge");

export type BridgeState = { port: number; pid: number; build: string };
type Health = { pid: number; build: string };

/** Changes whenever the bridge source changes, so a plugin upgrade replaces a bridge still running old code. */
export function buildId(srcDir: string): string {
  const hash = createHash("sha256");
  readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .forEach((name) => hash.update(name).update("\0").update(readFileSync(join(srcDir, name))));
  return hash.digest("hex").slice(0, 12);
}

export function readState(path: string): BridgeState | undefined {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeState>;
    return typeof state.port === "number" && typeof state.pid === "number" && typeof state.build === "string"
      ? { port: state.port, pid: state.pid, build: state.build }
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeState(path: string, state: BridgeState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Leaves the file alone if a newer bridge has already replaced it. */
export function removeStateIfOwned(path: string, pid: number): void {
  if (readState(path)?.pid === pid) unlinkSync(path);
}

/** Exclusive-create lock. A lock older than `staleMs` belongs to a plugin that died while starting the bridge. */
export function acquireLock(path: string, staleMs = 30_000): boolean {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs <= staleMs) return false;
        unlinkSync(path);
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

export async function health(port: number, fetchImpl: typeof fetch = fetch): Promise<Health | undefined> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<Health>;
    return typeof body.pid === "number" && typeof body.build === "string" ? { pid: body.pid, build: body.build } : undefined;
  } catch {
    return undefined;
  }
}

export type EnsureOptions = {
  build: string;
  serverPath: string;
  execPath: string;
  statePath?: string;
  lockPath?: string;
  logPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  kill?: (pid: number) => void;
};

const POLL_MS = 200;

/**
 * Returns a healthy bridge running the current build, starting one if needed. Every OpenCode plugin instance
 * calls this; instances do not share memory, so the state file and lock file coordinate them.
 */
export async function ensureBridge(options: EnsureOptions): Promise<BridgeState> {
  const statePath = options.statePath ?? join(cacheDir, "bridge.json");
  const lockPath = options.lockPath ?? join(cacheDir, "bridge.lock");
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const kill = options.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));

  const current = async (): Promise<BridgeState | "stale" | undefined> => {
    const state = readState(statePath);
    if (!state) return undefined;
    const alive = await health(state.port, options.fetchImpl);
    if (!alive) return undefined;
    return alive.build === options.build && alive.pid === state.pid ? state : "stale";
  };

  while (Date.now() < deadline) {
    const found = await current();
    if (found && found !== "stale") return found;

    if (!acquireLock(lockPath)) {
      await Bun.sleep(POLL_MS);
      continue;
    }
    try {
      const recheck = await current();
      if (recheck && recheck !== "stale") return recheck;
      if (recheck === "stale") {
        const stale = readState(statePath);
        if (stale) {
          try {
            kill(stale.pid);
          } catch {}
          while (Date.now() < deadline && (await health(stale.port, options.fetchImpl))) await Bun.sleep(POLL_MS);
        }
      }
      startBridge(options, statePath);
      while (Date.now() < deadline) {
        const started = await current();
        if (started && started !== "stale") return started;
        await Bun.sleep(POLL_MS);
      }
    } finally {
      releaseLock(lockPath);
    }
  }
  throw new Error(`The bridge did not become healthy within ${options.timeoutMs ?? 30_000} ms; see ${options.logPath ?? join(cacheDir, "bridge.log")}`);
}

/** `BUN_BE_BUN=1` makes OpenCode's own binary act as Bun, so users need no separate Bun install. */
function startBridge(options: EnsureOptions, statePath: string): void {
  const logPath = options.logPath ?? join(cacheDir, "bridge.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  const child = (options.spawn ?? nodeSpawn)(options.execPath, ["run", options.serverPath], {
    cwd: homedir(),
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...(options.env ?? process.env),
      BUN_BE_BUN: "1",
      DEVIN_BRIDGE_PORT: "0",
      DEVIN_BRIDGE_STATE: statePath,
      DEVIN_BRIDGE_BUILD: options.build,
    },
  });
  child.unref();
  closeSync(log);
}
