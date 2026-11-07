import { describe, expect, test } from "bun:test";
import { DevinAgent, devinEnv, devinSpawnCommand } from "./devin";

describe("devinEnv", () => {
  test("drops BUN_BE_BUN so Bun-compiled CLIs that Devin runs act as themselves", () => {
    expect(devinEnv({ BUN_BE_BUN: "1", PATH: "/bin", HOME: "/home/u" })).toEqual({ PATH: "/bin", HOME: "/home/u" });
  });

  test("drops DEVIN_BRIDGE_TOKEN so Devin's shell commands cannot call the bridge", () => {
    expect(devinEnv({ DEVIN_BRIDGE_TOKEN: "secret", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  test("does not change the environment it is given", () => {
    const env = { BUN_BE_BUN: "1" };
    devinEnv(env);
    expect(env).toEqual({ BUN_BE_BUN: "1" });
  });
});

describe("devinSpawnCommand", () => {
  const which = (paths: Record<string, string>) => (name: string) => paths[name] ?? null;

  test("runs the command as given outside Windows", () => {
    expect(devinSpawnCommand(["devin", "acp"], "darwin", which({ devin: "/x/devin.cmd" }))).toEqual({ file: "devin", args: ["acp"], shell: false });
  });

  test("runs a Windows executable by its full path without a shell", () => {
    expect(devinSpawnCommand(["devin", "acp"], "win32", which({ devin: "C:\\Tools\\devin.exe" }))).toEqual({
      file: "C:\\Tools\\devin.exe",
      args: ["acp"],
      shell: false,
    });
  });

  test("runs a Windows .cmd or .bat shim through the shell with the path quoted", () => {
    expect(devinSpawnCommand(["devin", "acp"], "win32", which({ devin: "C:\\Program Files\\devin\\devin.CMD" }))).toEqual({
      file: '"C:\\Program Files\\devin\\devin.CMD"',
      args: ["acp"],
      shell: true,
    });
    expect(devinSpawnCommand(["devin", "acp"], "win32", which({ devin: "C:\\devin.bat" })).shell).toBe(true);
  });

  test("does not quote a path that cmd.exe would expand", () => {
    expect(devinSpawnCommand(["devin", "acp"], "win32", which({ devin: "C:\\%TEMP%\\devin.cmd" }))).toEqual({ file: "devin", args: ["acp"], shell: false });
  });

  test("falls back to the bare name when Windows cannot find the command", () => {
    expect(devinSpawnCommand(["devin", "acp"], "win32", which({}))).toEqual({ file: "devin", args: ["acp"], shell: false });
  });
});

describe("DevinAgent.stop", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Starts the child; `initialize` never answers, as with a Devin that hangs while it starts. */
  const startHung = (agent: DevinAgent) => void agent.newSession("/").catch(() => {});
  const childPid = (agent: DevinAgent) => (agent as unknown as { child?: { pid?: number } }).child?.pid;

  test("ends a child that exits when its stdin closes, also before initialize answers", async () => {
    const agent = new DevinAgent(["sh", "-c", "cat > /dev/null"]);
    startHung(agent);
    await Bun.sleep(100);
    const pid = childPid(agent)!;
    const started = performance.now();
    await agent.stop(5000);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(alive(pid)).toBe(false);
  });

  test("kills a child that ignores its closed stdin after the grace period", async () => {
    const agent = new DevinAgent(["sleep", "30"]);
    startHung(agent);
    await Bun.sleep(100);
    const pid = childPid(agent)!;
    await agent.stop(200);
    await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  });

  test("starts no new child after stop", async () => {
    const agent = new DevinAgent(["sh", "-c", "cat > /dev/null"]);
    await agent.stop();
    await expect(agent.newSession("/")).rejects.toThrow("The bridge is stopping.");
    expect(childPid(agent)).toBeUndefined();
  });
});
