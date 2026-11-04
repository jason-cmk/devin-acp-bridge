import * as acp from "@agentclientprotocol/sdk";
import type {
  AvailableCommand,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { initialMode } from "./modes";
import { modelCatalog, thoughtLevels, type ModelCatalog, type ThoughtLevels } from "./models";
import type { ImageBlock } from "./openai";
import { addPolicyRule, alwaysAllowRule, decidePermission, loadPolicy, type RejectReason } from "./permissions";

export type TurnEvent =
  | { kind: "update"; update: SessionUpdate }
  | { kind: "permission"; request: RequestPermissionRequest; allowed: boolean; reason?: RejectReason; byUser?: true }
  /** A permission request that no policy rule decided. Devin waits until `respond` is called; `fallback` rejects. */
  | {
      kind: "permission-ask";
      request: RequestPermissionRequest;
      reason: RejectReason;
      fallback: RequestPermissionResponse;
      respond: (response: RequestPermissionResponse) => void;
      /** Saves an allow rule for this exact command. Absent when no safe rule exists (`alwaysAllowRule`). */
      remember?: () => void;
    }
  /** Devin's `ask_user_question` tool. Devin waits until `respond` is called. */
  | { kind: "question"; request: CreateElicitationRequest; respond: (response: CreateElicitationResponse) => void };

const CANCELLED: CreateElicitationResponse = { action: "cancel" };

export type ConfigId = "model" | "mode" | "thought_level";

type Connection = { child: ChildProcess; agent: acp.ClientContext; exited: Promise<never> };

const logDir = join(homedir(), ".cache", "devin-acp-bridge");
const debug = process.env.DEVIN_BRIDGE_DEBUG === "1";

export function debugLog(kind: string, params: unknown): void {
  if (debug) appendFileSync(join(logDir, "bridge-debug.ndjson"), `${JSON.stringify({ time: new Date().toISOString(), kind, params })}\n`);
}

/** The managed bridge runs with `BUN_BE_BUN=1` (managed.ts); Devin's shell would pass it to every Bun-compiled CLI. */
export function devinEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { BUN_BE_BUN: _, ...rest } = env;
  return rest;
}

/** One long-lived `devin acp` child shared by every session. Restarted on the next call after it exits. */
export class DevinAgent {
  private connection?: Promise<Connection>;
  private readonly listeners = new Map<string, (event: TurnEvent) => void>();
  private readonly exitHandlers: Array<() => void> = [];
  private readonly updateHandlers: Array<(sessionId: string, update: SessionUpdate) => void> = [];

  constructor(private readonly command: string[] = ["devin", "acp"]) {}

  get running(): boolean {
    return this.connection !== undefined;
  }

  /** Devin session IDs do not survive a restart of the bridge's connection, so callers must forget them. */
  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  /** Every session update, also those that arrive after the prompt turn ended (for example the session title). */
  onUpdate(handler: (sessionId: string, update: SessionUpdate) => void): void {
    this.updateHandlers.push(handler);
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
    const child = spawn(this.command[0]!, this.command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: devinEnv() });
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
        this.updateHandlers.forEach((handler) => handler(params.sessionId, params.update));
        this.listeners.get(params.sessionId)?.({ kind: "update", update: params.update });
      })
      .onRequest("session/request_permission", ({ params }) => {
        debugLog("session/request_permission", params);
        const decision = decidePermission(params, loadPolicy());
        const listener = this.listeners.get(params.sessionId);
        if (decision.askable && decision.reason && listener) {
          const { reason, response: fallback } = decision;
          const rule = alwaysAllowRule(params, reason);
          const remember = rule && (() => addPolicyRule(rule));
          return new Promise<RequestPermissionResponse>((respond) =>
            listener({ kind: "permission-ask", request: params, reason, fallback, respond, ...(remember ? { remember } : {}) }),
          );
        }
        listener?.({ kind: "permission", request: params, allowed: decision.allowed, reason: decision.reason });
        return decision.response;
      })
      .onRequest("elicitation/create", ({ params }) => {
        debugLog("elicitation/create", params);
        const sessionId = "sessionId" in params ? params.sessionId : undefined;
        const listener = typeof sessionId === "string" ? this.listeners.get(sessionId) : undefined;
        if (!listener) return CANCELLED;
        return new Promise<CreateElicitationResponse>((resolve) => listener({ kind: "question", request: params, respond: resolve }));
      })
      .connect(stream);

    await Promise.race([
      agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: "devin-acp-bridge", version: "0.0.0" },
      }),
      exited,
    ]);
    return { child, agent, exited };
  }

  async newSession(cwd: string): Promise<{ sessionId: string; catalog: ModelCatalog; mode?: string; thought: ThoughtLevels }> {
    const { agent, exited } = await this.connect();
    const session = await Promise.race([agent.request("session/new", { cwd, mcpServers: [] }), exited]);
    return {
      sessionId: session.sessionId,
      catalog: modelCatalog(session.configOptions),
      mode: initialMode(session.configOptions),
      thought: thoughtLevels(session.configOptions),
    };
  }

  /**
   * Thought levels differ by model and Devin reports them only for a session's current model, so this switches
   * a throwaway session through each model and deletes it again. No prompt is sent, so nothing is billed.
   */
  async probeThoughtLevels(cwd: string, models: string[]): Promise<Map<string, ThoughtLevels>> {
    const { agent, exited } = await this.connect();
    const session = await Promise.race([agent.request("session/new", { cwd, mcpServers: [] }), exited]);
    const found = new Map<string, ThoughtLevels>();
    try {
      for (const model of models) {
        const options = await this.setConfigOption(session.sessionId, "model", model).catch(() => undefined);
        if (options) found.set(model, thoughtLevels(options));
      }
      return found;
    } finally {
      await this.deleteSession(session.sessionId);
    }
  }

  /**
   * Devin sends a session's slash commands in an `available_commands_update` soon after `session/new`. They depend
   * on the cwd (project skills), so this opens a throwaway session there and deletes it again.
   */
  async listCommands(cwd: string, timeoutMs = 10_000): Promise<AvailableCommand[]> {
    const { agent, exited } = await this.connect();
    let sessionId: string | undefined;
    const early = new Map<string, AvailableCommand[]>();
    let resolveCommands!: (commands: AvailableCommand[]) => void;
    const received = new Promise<AvailableCommand[]>((resolve) => (resolveCommands = resolve));
    const handler = (id: string, update: SessionUpdate) => {
      if (update.sessionUpdate !== "available_commands_update") return;
      if (sessionId === undefined) early.set(id, update.availableCommands);
      else if (id === sessionId) resolveCommands(update.availableCommands);
    };
    this.updateHandlers.push(handler);
    try {
      const session = await Promise.race([agent.request("session/new", { cwd, mcpServers: [] }), exited]);
      sessionId = session.sessionId;
      const already = early.get(sessionId);
      if (already) return already;
      return await Promise.race([received, Bun.sleep(timeoutMs).then(() => [])]);
    } finally {
      this.updateHandlers.splice(this.updateHandlers.indexOf(handler), 1);
      if (sessionId) await this.deleteSession(sessionId);
    }
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

  /** Returns the session's config options after the change; a model change also changes `thought_level`. */
  async setConfigOption(sessionId: string, configId: ConfigId, value: string): Promise<SessionConfigOption[]> {
    const { agent, exited } = await this.connect();
    const result = await Promise.race([agent.request("session/set_config_option", { sessionId, configId, value }), exited]);
    return result.configOptions;
  }

  async prompt(sessionId: string, text: string, onEvent: (event: TurnEvent) => void, images: ImageBlock[] = []): Promise<StopReason> {
    const { agent, exited } = await this.connect();
    this.listeners.set(sessionId, onEvent);
    const prompt: ContentBlock[] = [{ type: "text", text }, ...images];
    try {
      const { stopReason } = await Promise.race([
        agent.request("session/prompt", { sessionId, prompt }),
        exited,
      ]);
      return stopReason;
    } finally {
      this.listeners.delete(sessionId);
    }
  }

  /**
   * Sends text into the session's running turn. Devin (`cognition.ai/midTurnPrompts`) reads it at its next step;
   * this request resolves when the turn ends, together with the original prompt (§11.13).
   */
  async steer(sessionId: string, text: string): Promise<void> {
    const { agent, exited } = await this.connect();
    await Promise.race([agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }), exited]);
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
