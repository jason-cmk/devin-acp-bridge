import * as acp from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { modelCatalog, type ModelCatalog } from "./models";
import { decidePermission, loadPolicy } from "./permissions";

export type TurnEvent =
  | { kind: "update"; update: SessionUpdate }
  | { kind: "permission"; request: RequestPermissionRequest; allowed: boolean };

type Connection = { child: ChildProcess; agent: acp.ClientContext; exited: Promise<never> };

const logDir = join(homedir(), ".cache", "devin-acp-bridge");
const debug = process.env.DEVIN_BRIDGE_DEBUG === "1";

function debugLog(kind: string, params: unknown): void {
  if (debug) appendFileSync(join(logDir, "bridge-debug.ndjson"), `${JSON.stringify({ time: new Date().toISOString(), kind, params })}\n`);
}

/** One long-lived `devin acp` child shared by every session. Restarted on the next call after it exits. */
export class DevinAgent {
  private connection?: Promise<Connection>;
  private readonly listeners = new Map<string, (event: TurnEvent) => void>();
  private readonly exitHandlers: Array<() => void> = [];

  constructor(private readonly command: string[] = ["devin", "acp"]) {}

  get running(): boolean {
    return this.connection !== undefined;
  }

  /** Devin session IDs do not survive a restart of the bridge's connection, so callers must forget them. */
  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  private connect(): Promise<Connection> {
    this.connection ??= this.start().catch((error) => {
      this.connection = undefined;
      throw error;
    });
    return this.connection;
  }

  private async start(): Promise<Connection> {
    mkdirSync(logDir, { recursive: true });
    const child = spawn(this.command[0]!, this.command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr!.pipe(createWriteStream(join(logDir, "devin-acp.log"), { flags: "a" }));
    const exited = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        console.error(`devin acp exited (code=${code}, signal=${signal}); restarting on next request`);
        this.connection = undefined;
        this.exitHandlers.forEach((handler) => handler());
        reject(new Error(`The Devin agent process exited (code=${code}, signal=${signal}).`));
      });
      child.once("error", reject);
    });
    exited.catch(() => {});

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const { agent } = acp
      .client({ name: "devin-acp-bridge" })
      .onNotification("session/update", ({ params }) => {
        debugLog("session/update", params);
        this.listeners.get(params.sessionId)?.({ kind: "update", update: params.update });
      })
      .onRequest("session/request_permission", ({ params }) => {
        debugLog("session/request_permission", params);
        const decision = decidePermission(params, loadPolicy());
        this.listeners.get(params.sessionId)?.({ kind: "permission", request: params, allowed: decision.allowed });
        return decision.response;
      })
      .connect(stream);

    await Promise.race([
      agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "devin-acp-bridge", version: "0.0.0" },
      }),
      exited,
    ]);
    return { child, agent, exited };
  }

  async newSession(cwd: string): Promise<{ sessionId: string; catalog: ModelCatalog }> {
    const { agent, exited } = await this.connect();
    const session = await Promise.race([agent.request("session/new", { cwd, mcpServers: [] }), exited]);
    return { sessionId: session.sessionId, catalog: modelCatalog(session.configOptions) };
  }

  /** Devin only reports its models per session, so this opens a throwaway session and deletes it again. */
  async listModels(cwd: string): Promise<ModelCatalog> {
    const { agent, exited } = await this.connect();
    const session = await Promise.race([agent.request("session/new", { cwd, mcpServers: [] }), exited]);
    try {
      return modelCatalog(session.configOptions);
    } finally {
      await this.deleteSession(session.sessionId);
    }
  }

  /** Devin persists every session, so sessions that never ran a turn are removed from its list. */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.connection) return;
    const { agent } = await this.connection;
    await agent.request("session/delete", { sessionId }).catch(() => {});
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const { agent, exited } = await this.connect();
    await Promise.race([agent.request("session/set_config_option", { sessionId, configId: "model", value: model }), exited]);
  }

  async prompt(sessionId: string, text: string, onEvent: (event: TurnEvent) => void): Promise<StopReason> {
    const { agent, exited } = await this.connect();
    this.listeners.set(sessionId, onEvent);
    try {
      const { stopReason } = await Promise.race([
        agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
        exited,
      ]);
      return stopReason;
    } finally {
      this.listeners.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.connection) return;
    const { agent } = await this.connection;
    await agent.notify("session/cancel", { sessionId });
  }

  stop(): void {
    this.connection?.then(({ child }) => child.stdin?.end()).catch(() => {});
  }
}
