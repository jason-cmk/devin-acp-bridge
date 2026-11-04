import type { PlanEntry, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import { isAbsolute, relative } from "node:path";
import type { TurnEvent } from "./devin";
import { unifiedDiff } from "./diff";
import type { Delta } from "./openai";
import { permissionLabel } from "./permissions";

type ToolState = {
  title: string;
  kind?: ToolKind;
  paths: string[];
  command?: string;
  output?: string;
  exitCode?: number;
  announced: boolean;
};

export type TurnUsage = { promptTokens: number; completionTokens: number };

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
  private queue: string[] = [];
  private inFence = false;
  private partialLine = "";
  private trailingNewlines = 2;
  private renderedPlanKey?: string;
  private latestPlan?: PlanEntry[];
  usage?: TurnUsage;

  constructor(private readonly cwd: string) {}

  handle(event: TurnEvent): Delta[] {
    if (event.kind === "permission") {
      if (!event.allowed) this.rejectedToolCalls.add(event.request.toolCall.toolCallId);
      const verdict = event.allowed ? "allowed" : "rejected";
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
        if (meta["cognition.ai/subagent_context"]) return [];
        const input = meta["cognition.ai/inputTokens"];
        const output = meta["cognition.ai/outputTokens"];
        this.usage = {
          promptTokens: typeof input === "number" ? input : update.used,
          completionTokens: typeof output === "number" ? output : 0,
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
    const state = this.tools.get(update.toolCallId) ?? { title: "Tool", paths: [], announced: false };
    if (update.title) state.title = update.title;
    if (update.kind) state.kind = update.kind;
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
      if (hunks.length) blocks.push(`${inlineCode(this.displayPath(item.path))}\n\n${fence("diff", hunks)}`);
    }
    const finished = update.status === "completed" || update.status === "failed";
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
