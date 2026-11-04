import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, buildId, ensureBridge, readState, releaseLock, removeStateIfOwned, writeState } from "./managed";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devin-acp-bridge-managed-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildId", () => {
  test("changes when a source file changes and ignores test files", () => {
    writeFileSync(join(dir, "a.ts"), "one");
    const first = buildId(dir);
    writeFileSync(join(dir, "a.test.ts"), "tests");
    expect(buildId(dir)).toBe(first);
    writeFileSync(join(dir, "a.ts"), "two");
    expect(buildId(dir)).not.toBe(first);
  });
});

describe("state file", () => {
  test("round-trips and rejects malformed content", () => {
    const path = join(dir, "bridge.json");
    writeState(path, { port: 1234, pid: 42, build: "b1" });
    expect(readState(path)).toEqual({ port: 1234, pid: 42, build: "b1" });
    writeFileSync(path, JSON.stringify({ port: "x" }));
    expect(readState(path)).toBeUndefined();
  });

  test("is removed only by the bridge that owns it", () => {
    const path = join(dir, "bridge.json");
    writeState(path, { port: 1, pid: 7, build: "b" });
    removeStateIfOwned(path, 8);
    expect(existsSync(path)).toBe(true);
    removeStateIfOwned(path, 7);
    expect(existsSync(path)).toBe(false);
  });
});

describe("acquireLock", () => {
  test("lets one holder in until it releases", () => {
    const path = join(dir, "bridge.lock");
    expect(acquireLock(path)).toBe(true);
    expect(acquireLock(path)).toBe(false);
    releaseLock(path);
    expect(acquireLock(path)).toBe(true);
  });

  test("takes over a stale lock", () => {
    const path = join(dir, "bridge.lock");
    writeFileSync(path, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(acquireLock(path, 30_000)).toBe(true);
  });
});

type Fake = { healthy: Map<number, { pid: number; build: string }>; spawned: string[][]; killed: number[] };

function fakes(statePath: string, startPort = 5000): Fake & { spawn: typeof spawn; fetchImpl: typeof fetch; kill: (pid: number) => void } {
  const fake: Fake = { healthy: new Map(), spawned: [], killed: [] };
  let nextPort = startPort;
  return {
    ...fake,
    spawn: ((command: string, args: string[], options: { env: Record<string, string> }) => {
      fake.spawned.push([command, ...args, options.env.BUN_BE_BUN!, options.env.DEVIN_BRIDGE_BUILD!]);
      const port = nextPort++;
      const pid = 1000 + port;
      fake.healthy.set(port, { pid, build: options.env.DEVIN_BRIDGE_BUILD! });
      writeState(statePath, { port, pid, build: options.env.DEVIN_BRIDGE_BUILD! });
      return { unref() {} };
    }) as unknown as typeof spawn,
    fetchImpl: (async (url: string) => {
      const port = Number(new URL(url).port);
      const body = fake.healthy.get(port);
      return body ? Response.json(body) : new Response("down", { status: 503 });
    }) as unknown as typeof fetch,
    kill: (pid: number) => {
      fake.killed.push(pid);
      for (const [port, body] of fake.healthy) if (body.pid === pid) fake.healthy.delete(port);
    },
  };
}

describe("ensureBridge", () => {
  const options = (statePath: string, f: ReturnType<typeof fakes>, build = "b1") => ({
    build,
    serverPath: "/repo/src/server.ts",
    execPath: "/usr/local/bin/opencode",
    statePath,
    lockPath: join(dir, "bridge.lock"),
    logPath: join(dir, "bridge.log"),
    timeoutMs: 3000,
    spawn: f.spawn,
    fetchImpl: f.fetchImpl,
    kill: f.kill,
  });

  test("starts a bridge with OpenCode's binary acting as Bun, then reuses it", async () => {
    const statePath = join(dir, "bridge.json");
    const f = fakes(statePath);
    const first = await ensureBridge(options(statePath, f));
    const second = await ensureBridge(options(statePath, f));
    expect(second).toEqual(first);
    expect(f.spawned).toEqual([["/usr/local/bin/opencode", "run", "/repo/src/server.ts", "1", "b1"]]);
    expect(existsSync(join(dir, "bridge.lock"))).toBe(false);
  });

  test("replaces a bridge running an older build", async () => {
    const statePath = join(dir, "bridge.json");
    const f = fakes(statePath);
    const old = await ensureBridge(options(statePath, f, "old"));
    const current = await ensureBridge(options(statePath, f, "new"));
    expect(f.killed).toEqual([old.pid]);
    expect(current.build).toBe("new");
    expect(current.port).not.toBe(old.port);
  });

  test("starts a new bridge when the recorded one no longer answers", async () => {
    const statePath = join(dir, "bridge.json");
    const f = fakes(statePath);
    writeState(statePath, { port: 4999, pid: 1, build: "b1" });
    const state = await ensureBridge(options(statePath, f));
    expect(state.port).toBe(5000);
    expect(f.killed).toEqual([]);
  });

  test("waits for another plugin instance that holds the lock", async () => {
    const statePath = join(dir, "bridge.json");
    const f = fakes(statePath);
    writeFileSync(join(dir, "bridge.lock"), "");
    setTimeout(() => {
      f.healthy.set(6000, { pid: 7000, build: "b1" });
      writeState(statePath, { port: 6000, pid: 7000, build: "b1" });
    }, 300);
    const state = await ensureBridge(options(statePath, f));
    expect(state).toEqual({ port: 6000, pid: 7000, build: "b1" });
    expect(f.spawned).toEqual([]);
  });

  test("fails with a pointer to the log when the bridge never becomes healthy", async () => {
    const statePath = join(dir, "bridge.json");
    const f = fakes(statePath);
    const broken = { ...options(statePath, f), timeoutMs: 500, spawn: (() => ({ unref() {} })) as unknown as typeof spawn };
    await expect(ensureBridge(broken)).rejects.toThrow(join(dir, "bridge.log"));
    expect(readFileSync(join(dir, "bridge.log"), "utf8")).toBe("");
  });
});
