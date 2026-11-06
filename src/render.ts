import type { PlanEntry, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import { isAbsolute, relative } from "node:path";
import type { TurnEvent } from "./devin";
import { unifiedDiff } from "./diff";
import type { Delta, ToolCall } from "./openai";
import { permissionLabel } from "./permissions";

type ToolState = {
  title: string;
  kind?: ToolKind;
  paths: string[];
  command?: string;
  output?: string;
  exitCode?: number;
  rawInput?: Record<string, unknown>;
  /** Devin's own tool name, for example `kill_shell` or `mcp__slack__slack_read_channel`. */
  devinTool?: string;
  announced: boolean;
  /** Card mode: markdown held back until the tool finishes, and the changed files for the card. */
  held: string[];
  files: CardFile[];
  finished?: boolean;
};

const SUBAGENT_CONTEXT = "cognition.ai/subagent_context";

/**
 * Devin marks each tool call of its own subagents with the subagent's ID. It sends no update after the first
 * `tool_call`, so the call never finishes; the bridge shows only the parent's `run_subagent` and `read_subagent`.
 */
function isSubagentCall(meta: Record<string, unknown> | null | undefined): boolean {
  const context = meta?.[SUBAGENT_CONTEXT] as { parentAgentId?: unknown } | undefined;
  return typeof context?.parentAgentId === "string" && context.parentAgentId !== "root";
}

/** `promptTokens` includes `cachedTokens`, as OpenAI's `prompt_tokens` includes `cached_tokens`. */
export type TurnUsage = { promptTokens: number; completionTokens: number; cachedTokens?: number };
/** One changed file, in the shape of OpenCode's `edit` tool metadata. */
export type CardFile = { file: string; patch: string; status: "added" | "modified"; additions: number; deletions: number };
/**
 * A finished Devin tool call, drawn by OpenCode's renderer for `tool` (§6.16). `input` and `metadata` have the
 * shapes that renderer reads; `output` is the tool result text.
 */
export type ToolCard = { title: string; tool: string; input: Record<string, unknown>; output: string; metadata: Record<string, unknown> };
/**
 * The plugin registers this tool, and the bridge sends cards only when a request offers it. The plugin's
 * `execute.before` hook sends every call whose ID starts with `CARD_CALL_PREFIX` to this tool, so OpenCode never
 * runs its own tool of the same name. The plugin registers the hook before the tool.
 */
export const CARD_TOOL = "devin_card";
export const CARD_CALL_PREFIX = "devincard_";

export function cardToolCall(callId: string, card: ToolCard): ToolCall {
  return { id: callId, type: "function", function: { name: card.tool, arguments: JSON.stringify(card.input) } };
}

/** OpenCode tool names that the fallback must not take: their renderers expect other input shapes. */
const OPENCODE_TOOLS = new Set([
  "batch", "bash", "edit", "execute", "glob", "grep", "invalid", "list", "patch", "question", "read", "shell", "skill",
  "subagent", "task", "todoread", "todowrite", "webfetch", "websearch", "write",
]);
const MAX_INPUT_TEXT = 200;

/** OpenCode names MCP tools `<server>_<tool>`; Devin names them `mcp__<server>__<tool>`. */
function fallbackToolName(state: ToolState): string {
  const mcp = state.devinTool?.match(/^mcp__(.+?)__(.+)$/);
  const name = (mcp ? `${mcp[1]}_${mcp[2]}` : state.devinTool ?? state.kind ?? "tool").replace(/[^A-Za-z0-9_-]/g, "_");
  return OPENCODE_TOOLS.has(name) ? `devin_${name}` : name;
}

/** The string, number and boolean fields of Devin's input: OpenCode's generic renderer shows only those. */
function scalarInput(rawInput: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rawInput ?? {}).flatMap(([key, value]): Array<[string, unknown]> => {
    if (typeof value === "number" || typeof value === "boolean") return [[key, value]];
    if (typeof value !== "string") return [];
    const firstLine = value.split("\n")[0]!;
    return [[key, firstLine.length > MAX_INPUT_TEXT ? `${firstLine.slice(0, MAX_INPUT_TEXT)}…` : firstLine]];
  }));
}

function stringField(rawInput: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = rawInput?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberField(rawInput: Record<string, unknown> | undefined, key: string): Record<string, number> {
  const value = rawInput?.[key];
  return typeof value === "number" ? { [key]: value } : {};
}

/** OpenCode's own todo tool (`experimental.todo`); Devin's plan goes to it as a native todo list (§6.18). */
export const TODO_TOOL = "todowrite";

export function todoToolCall(callId: string, entries: PlanEntry[]): ToolCall {
  const todos = entries.map((entry) => ({ content: entry.content, status: entry.status }));
  return { id: callId, type: "function", function: { name: TODO_TOOL, arguments: JSON.stringify({ todos }) } };
}

/** Cards by call ID, for the plugin's `execute`. Keeps the newest `limit` cards. */
export class CardStore<T = ToolCard> {
  private readonly cards = new Map<string, T>();

  constructor(private readonly limit = 500) {}

  put(callId: string, card: T): void {
    this.cards.delete(callId);
    this.cards.set(callId, card);
    for (const oldest of this.cards.keys()) {
      if (this.cards.size <= this.limit) break;
      this.cards.delete(oldest);
    }
  }

  get(callId: string): T | undefined {
    return this.cards.get(callId);
  }
}
const MAX_CARD_LINES = 200;

const FENCE = /^ {0,3}(```|~~~)/;
const MAX_PATHS = 3;
const MAX_OUTPUT_LINES = 20;
const MAX_INLINE = 120;
/** Devin's stand-in output for a command that printed nothing; the exit code is reported separately. */
const EXIT_PLACEHOLDER = /^Exited with code -?\d+$/;

function inlineCode(text: string): string {
  const firstLine = text.split("\n")[0]!;
  const clipped = firstLine.length > MAX_INLINE ? `${firstLine.slice(0, MAX_INLINE)}…` : firstLine;
  return clipped.includes("`") ? `\`\` ${clipped} \`\`` : `\`${clipped}\``;
}

function fence(language: string, lines: string[]): string {
  const longestTicks = Math.max(2, ...lines.map((line) => line.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0));
  const ticks = "`".repeat(longestTicks + 1);
  return [`${ticks}${language}`, ...lines, ticks].join("\n");
}

function clipLines(text: string, limit: number): string {
  const lines = text.split("\n");
  return lines.length > limit ? [...lines.slice(0, limit), `… ${lines.length - limit} more lines`].join("\n") : text;
}

function planBlock(entries: PlanEntry[]): string {
  const lines = entries.map((entry) => {
    if (entry.status === "completed") return `- [x] ${entry.content}`;
    if (entry.status === "in_progress") return `- [ ] **${entry.content}** _(in progress)_`;
    return `- [ ] ${entry.content}`;
  });
  return ["**Plan**", "", ...lines].join("\n");
}

function contentText(content: ToolCallContent[] | null | undefined): string {
  return (content ?? [])
    .flatMap((item) => (item.type === "content" && item.content.type === "text" ? [item.content.text] : []))
    .join("\n")
    .trim();
}

function exitCodeOf(meta: Record<string, unknown> | null | undefined): number | undefined {
  const code = (meta?.terminal_exit as { exit_code?: unknown } | undefined)?.exit_code;
  return typeof code === "number" ? code : undefined;
}

function commandOf(rawInput: unknown): string | undefined {
  const command = (rawInput as { command?: unknown } | null | undefined)?.command;
  return typeof command === "string" ? command : undefined;
}

/**
 * Turns one Devin prompt turn into OpenAI deltas. Tool activity is emitted as markdown blocks between the
 * agent's own text, never inside a code fence the agent has open.
 */
export class TurnRenderer {
  private readonly tools = new Map<string, ToolState>();
  private readonly renderedDiffs = new Set<string>();
  private readonly rejectedToolCalls = new Set<string>();
  private readonly subagentToolCalls = new Set<string>();
  private queue: string[] = [];
  private inFence = false;
  private partialLine = "";
  private trailingNewlines = 2;
  private renderedPlanKey?: string;
  private latestPlan?: PlanEntry[];
  private readonly cards: ToolCard[] = [];
  private readonly withCards: boolean;
  private readonly todos: PlanEntry[][] = [];
  private readonly withTodos: boolean;
  usage?: TurnUsage;

  constructor(private readonly cwd: string, options: { cards?: boolean; todos?: boolean } = {}) {
    this.withCards = options.cards ?? false;
    this.withTodos = options.todos ?? false;
  }

  /** Card mode: the next finished tool call, in the order the tools finished. */
  takeCard(): ToolCard | undefined {
    return this.cards.shift();
  }

  /** Todo mode: the next changed plan, in order. */
  takeTodos(): PlanEntry[] | undefined {
    return this.todos.shift();
  }

  /** A plan as markdown, for a response whose request did not offer the todo tool. */
  planMarkdown(entries: PlanEntry[]): Delta[] {
    return this.block(planBlock(entries));
  }

  /** A card as markdown, for a response whose request did not offer the card tool. */
  cardMarkdown(card: ToolCard): Delta[] {
    const files = Array.isArray(card.metadata.files) ? (card.metadata.files as CardFile[]) : [];
    const shellOutput = card.tool === "shell" && card.output ? [fence("text", card.output.split("\n"))] : [];
    const diffs = files.map((file) => `${inlineCode(file.file)}\n\n${fence("diff", file.patch.split("\n").slice(2))}`);
    const exit = typeof card.metadata.exit === "number" && card.metadata.exit !== 0 ? [`> ✗ exited with code ${card.metadata.exit}`] : [];
    return this.block([`> **${card.title}**`, ...shellOutput, ...diffs, ...exit].join("\n\n"));
  }

  handle(event: TurnEvent): Delta[] {
    if (event.kind === "question" || event.kind === "permission-ask") return [];
    if (event.kind === "permission") {
      if (!event.allowed) this.rejectedToolCalls.add(event.request.toolCall.toolCallId);
      if (event.shown) return [];
      const verdict = event.byUser ? `${event.allowed ? "allowed" : "rejected"} by you`
        : event.allowed ? "allowed" : `rejected by bridge policy (${event.reason ?? "no matching rule"})`;
      return this.block(`> **Permission** ${verdict}: ${permissionLabel(event.request)}`);
    }

    const { update } = event;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return update.content.type === "text" ? this.agentText(update.content.text) : [];
      case "agent_thought_chunk":
        return update.content.type === "text" ? [{ reasoning_content: update.content.text }] : [];
      case "tool_call":
      case "tool_call_update":
        return this.toolUpdate(update);
      case "plan":
        return this.plan(update.entries);
      case "usage_update": {
        const meta = update._meta ?? {};
        if (meta[SUBAGENT_CONTEXT]) return [];
        const input = meta["cognition.ai/inputTokens"];
        const output = meta["cognition.ai/outputTokens"];
        const cacheRead = meta["cognition.ai/cachedReadTokens"];
        this.usage = {
          promptTokens: typeof input === "number" ? input : update.used,
          completionTokens: typeof output === "number" ? output : 0,
          ...(typeof cacheRead === "number" ? { cachedTokens: cacheRead } : {}),
        };
        return [];
      }
      default:
        return [];
    }
  }

  finish(): Delta[] {
    const deltas: Delta[] = [];
    if (this.inFence) deltas.push(...this.agentText(`${this.partialLine ? "\n" : ""}\`\`\`\n`));
    for (const state of this.tools.values()) if (!state.finished) this.queue.push(...state.held.splice(0));
    const planKey = this.latestPlan && JSON.stringify(this.latestPlan);
    if (this.latestPlan && planKey !== this.renderedPlanKey) {
      this.renderedPlanKey = planKey;
      this.queue.push(planBlock(this.latestPlan));
    }
    return [...deltas, ...this.flush()];
  }

  private agentText(text: string): Delta[] {
    let consumed = 0;
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      const line = this.partialLine + text.slice(consumed, newline);
      consumed = newline + 1;
      this.partialLine = "";
      if (FENCE.test(line)) {
        this.inFence = !this.inFence;
        if (!this.inFence && this.queue.length && consumed < text.length) {
          return [...this.emitText(text.slice(0, consumed)), ...this.agentText(text.slice(consumed))];
        }
      }
      newline = text.indexOf("\n", consumed);
    }
    this.partialLine += text.slice(consumed);
    return this.emitText(text);
  }

  private emitText(text: string): Delta[] {
    const trailing = text.length - text.replace(/\n+$/, "").length;
    this.trailingNewlines = trailing === text.length ? this.trailingNewlines + trailing : trailing;
    return [{ content: text }, ...this.flush()];
  }

  note(markdown: string): Delta[] {
    return this.block(markdown);
  }

  private block(markdown: string): Delta[] {
    this.queue.push(markdown);
    return this.flush();
  }

  private flush(): Delta[] {
    if (this.inFence || this.queue.length === 0) return [];
    const lead = "\n".repeat(Math.max(0, 2 - this.trailingNewlines));
    const content = `${lead}${this.queue.join("\n\n")}\n\n`;
    this.queue = [];
    this.trailingNewlines = 2;
    this.partialLine = "";
    return [{ content }];
  }

  private plan(entries: PlanEntry[]): Delta[] {
    if (this.withTodos) {
      const key = JSON.stringify(entries);
      if (key !== this.renderedPlanKey) this.todos.push(entries);
      this.renderedPlanKey = key;
      return [];
    }
    this.latestPlan = entries;
    if (this.renderedPlanKey !== undefined) return [];
    this.renderedPlanKey = JSON.stringify(entries);
    return this.block(planBlock(entries));
  }

  private toolUpdate(update: {
    toolCallId: string;
    title?: string | null;
    kind?: ToolKind | null;
    status?: string | null;
    content?: ToolCallContent[] | null;
    locations?: Array<{ path: string }> | null;
    rawInput?: unknown;
    _meta?: Record<string, unknown> | null;
  }): Delta[] {
    if (this.subagentToolCalls.has(update.toolCallId)) return [];
    if (isSubagentCall(update._meta)) {
      this.subagentToolCalls.add(update.toolCallId);
      return [];
    }
    const state = this.tools.get(update.toolCallId) ?? { title: "Tool", paths: [], announced: false, held: [], files: [] };
    if (update.title) state.title = update.title;
    if (update.kind) state.kind = update.kind;
    if (update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)) state.rawInput = update.rawInput as Record<string, unknown>;
    const devinTool = update._meta?.["cognition.ai/inferenceToolName"];
    if (typeof devinTool === "string" && devinTool) state.devinTool = devinTool;
    if (update.locations?.length) state.paths = update.locations.map((location) => this.displayPath(location.path));
    state.command = commandOf(update.rawInput) ?? state.command;
    // Devin streams shell output in in_progress updates; the final completed update carries no content.
    const latestOutput = contentText(update.content);
    if (latestOutput) state.output = EXIT_PLACEHOLDER.test(latestOutput) ? undefined : latestOutput;
    state.exitCode = exitCodeOf(update._meta) ?? state.exitCode;
    this.tools.set(update.toolCallId, state);

    const blocks: string[] = [];
    if (!state.announced) {
      state.announced = true;
      blocks.push(this.toolLine(state));
    }
    for (const item of update.content ?? []) {
      if (item.type !== "diff") continue;
      const key = `${update.toolCallId}:${item.path}`;
      if (this.renderedDiffs.has(key)) continue;
      this.renderedDiffs.add(key);
      const hunks = unifiedDiff(item.oldText ?? "", item.newText);
      if (hunks.length) {
        const file = this.displayPath(item.path);
        blocks.push(`${inlineCode(file)}\n\n${fence("diff", hunks)}`);
        state.files.push({
          file,
          patch: [`--- ${file}`, `+++ ${file}`, ...hunks].join("\n"),
          status: item.oldText ? "modified" : "added",
          additions: hunks.filter((line) => line.startsWith("+")).length,
          deletions: hunks.filter((line) => line.startsWith("-")).length,
        });
      }
    }
    const finished = update.status === "completed" || update.status === "failed";
    if (this.withCards) return this.holdForCard(update.toolCallId, state, blocks, finished, update.status === "failed" ? contentText(update.content) : "");
    if (finished && state.kind === "execute" && state.output && !this.rejectedToolCalls.has(update.toolCallId)) {
      const output = state.output.split("\n");
      const shown = output.slice(0, MAX_OUTPUT_LINES);
      if (output.length > MAX_OUTPUT_LINES) shown.push(`… ${output.length - MAX_OUTPUT_LINES} more lines`);
      blocks.push(fence("text", shown));
    }
    if (finished && state.kind === "execute" && state.exitCode !== undefined && state.exitCode !== 0) {
      blocks.push(`> ✗ **${state.title}** exited with code ${state.exitCode}`);
    } else if (update.status === "failed" && !this.rejectedToolCalls.has(update.toolCallId)) {
      const reason = (state.kind === "execute" ? "" : contentText(update.content) || state.output || "").split("\n")[0];
      blocks.push(`> ✗ **${state.title}** failed${reason ? `: ${reason}` : ""}`);
    }
    blocks.forEach((markdown) => this.queue.push(markdown));
    return this.flush();
  }

  /** Rejected calls stay markdown: the permission line already explains them, and a card would add nothing. */
  private holdForCard(toolCallId: string, state: ToolState, blocks: string[], finished: boolean, failure: string): Delta[] {
    state.held.push(...blocks);
    if (!finished || state.finished) return [];
    state.finished = true;
    if (this.rejectedToolCalls.has(toolCallId)) {
      this.queue.push(...state.held.splice(0));
      return this.flush();
    }
    state.held = [];
    this.cards.push(this.card(state, failure));
    return [];
  }

  /** Picks the OpenCode tool whose renderer fits Devin's tool, and fills the input and metadata it reads. */
  private card(state: ToolState, failure: string): ToolCard {
    const title = this.cardTitle(state);
    const raw = state.rawInput;
    const failed = failure && state.kind !== "execute" ? `Failed: ${failure}` : "";
    const output = [state.output ? clipLines(state.output, MAX_CARD_LINES) : "", failed].filter(Boolean).join("\n\n");
    const path = stringField(raw, "file_path") ?? stringField(raw, "path");
    const displayPath = path ? this.displayPath(path) : state.paths[0];
    if (state.kind === "execute" && state.command) {
      const workdir = stringField(raw, "workdir");
      return {
        title,
        tool: "shell",
        input: { command: state.command, ...(workdir ? { workdir: this.displayPath(workdir) } : {}) },
        output: state.output ? clipLines(state.output, MAX_CARD_LINES) : "",
        metadata: { ...(state.exitCode !== undefined ? { exit: state.exitCode } : {}), truncated: false },
      };
    }
    if (state.files.length > 0) {
      const summary = state.files.map((file) => `${file.status === "added" ? "Created" : "Edited"} ${file.file}`).join("\n");
      return {
        title,
        tool: state.files.length === 1 ? "edit" : "patch",
        input: state.files.length === 1 ? { path: state.files[0]!.file } : {},
        output: [summary, failed].filter(Boolean).join("\n\n"),
        metadata: { files: state.files, truncated: false },
      };
    }
    if (state.kind === "read" && displayPath) {
      return { title, tool: "read", input: { path: displayPath, ...numberField(raw, "offset"), ...numberField(raw, "limit") }, output, metadata: { truncated: false } };
    }
    const query = stringField(raw, "query");
    if (state.kind === "search" && query) {
      const include = stringField(raw, "file_pattern");
      return { title, tool: "grep", input: { pattern: query, ...(displayPath ? { path: displayPath } : {}), ...(include ? { include } : {}) }, output, metadata: {} };
    }
    if (state.kind === "fetch" && query) return { title, tool: "websearch", input: { query }, output, metadata: {} };
    const url = stringField(raw, "url");
    if (state.kind === "fetch" && url) return { title, tool: "webfetch", input: { url }, output, metadata: {} };
    return { title, tool: fallbackToolName(state), input: scalarInput(raw), output, metadata: {} };
  }

  private cardTitle(state: ToolState): string {
    if (state.kind === "execute" && state.command) return `Run ${state.command.split("\n")[0]}`;
    const paths = state.paths.slice(0, MAX_PATHS);
    if (state.paths.length > MAX_PATHS) paths.push(`+${state.paths.length - MAX_PATHS} more`);
    return [state.title, ...paths].join(" ");
  }

  private toolLine(state: ToolState): string {
    if (state.kind === "execute" && state.command) return `> **Run** ${inlineCode(state.command)}`;
    const paths = state.paths.slice(0, MAX_PATHS).map(inlineCode);
    if (state.paths.length > MAX_PATHS) paths.push(`+${state.paths.length - MAX_PATHS} more`);
    return `> **${state.title}**${paths.length ? ` ${paths.join(", ")}` : ""}`;
  }

  private displayPath(path: string): string {
    if (!isAbsolute(path)) return path;
    const fromCwd = relative(this.cwd, path);
    return fromCwd && !fromCwd.startsWith("..") && !isAbsolute(fromCwd) ? fromCwd : path;
  }
}
