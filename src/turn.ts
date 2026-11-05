import type { PlanEntry, StopReason } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import type { TurnEvent } from "./devin";
import type { Delta } from "./openai";
import { allowOnceResponse, nativePermission, type NativePermission, PERMISSION_ALLOW, PERMISSION_ALWAYS, PERMISSION_NATIVE_ALWAYS, permissionQuestion } from "./permissions";
import { elicitationResponse, questionsFromElicitation, type QuestionForm } from "./questions";
import type { ToolCard, TurnRenderer } from "./render";

export type PendingQuestion = { callId: string; form: QuestionForm };
export type TurnStep =
  | { kind: "done"; stopReason: StopReason }
  | { kind: "question"; question: PendingQuestion }
  | { kind: "card"; callId: string; card: ToolCard }
  | { kind: "todos"; callId: string; entries: PlanEntry[] }
  | { kind: "permission"; callId: string; permission: NativePermission }
  | { kind: "steered" };

/** The OpenCode tools the current request offered. */
export type Offers = { question: boolean; card?: boolean; todo?: boolean; permission?: boolean };

type Waiter = { resolve: (step: TurnStep) => void; reject: (error: Error) => void };
type Final = { step: TurnStep } | { error: Error };
/** Labels per question as OpenCode returned them; `undefined` means no answer (dismissed, moved on, timed out). */
type Answers = string[][] | undefined;
/**
 * A point where the response ends with one OpenCode tool call: a question (`form`), a tool card (`card`), a todo
 * list (`todos`) or a native permission check (`permission`, with `form` as the fallback). `resolve` returns the
 * output that reports the answer; it goes out before anything queued behind the pause.
 */
type Pause = {
  form?: QuestionForm;
  card?: ToolCard;
  todos?: PlanEntry[];
  permission?: NativePermission;
  resolve: (answers: Answers) => Delta[] | void;
};
type Item = { delta: Delta } | { pause: Pause };

/**
 * One Devin prompt turn that can span several HTTP responses. The turn pauses when Devin asks a question, asks
 * a permission that no policy rule decided, or (with tool cards) finishes a tool call: the current response
 * ends with one OpenCode tool call, and the next request that carries the tool result resumes the same turn.
 * Output and pauses that arrive while no response is attached wait in order for the next response.
 */
export class Turn {
  readonly finished: Promise<StopReason>;
  private sink?: (delta: Delta) => void;
  private offers: Offers = { question: false };
  private items: Item[] = [];
  private waiter?: Waiter;
  private final?: Final;
  private pending?: Pause & { callId: string; native?: boolean };

  constructor(
    readonly renderer: TurnRenderer,
    run: (onEvent: (event: TurnEvent) => void) => Promise<StopReason>,
    private readonly newCallId: () => string = () => `call_${randomUUID().replaceAll("-", "")}`,
  ) {
    this.finished = run((event) => this.handle(event));
    this.finished.then(
      (stopReason) => this.end({ step: { kind: "done", stopReason } }),
      (error: Error) => this.end({ error }),
    );
  }

  /** The question the response ended with; not set when a native permission check was sent instead. */
  get question(): PendingQuestion | undefined {
    return this.pending?.form && !this.pending.native ? { callId: this.pending.callId, form: this.pending.form } : undefined;
  }

  /** True while the turn waits for the result of a native permission check. */
  get awaitingPermission(): boolean {
    return this.pending?.native === true;
  }

  /** The tool call ID the response ended with, while the turn waits for its result. */
  get pendingCallId(): string | undefined {
    return this.pending?.callId;
  }

  /**
   * Attaches a response and resolves when the turn ends or pauses. `offers` says which tools the request offered:
   * OpenCode's `question` and `todowrite`, and the plugin's `devin` card and `devin_permission` tools. A boolean
   * is the `question` offer alone.
   */
  next(sink: (delta: Delta) => void, offers: Offers | boolean): Promise<TurnStep> {
    this.sink = sink;
    this.offers = typeof offers === "boolean" ? { question: offers } : offers;
    const step = new Promise<TurnStep>((resolve, reject) => (this.waiter = { resolve, reject }));
    this.drain();
    if (this.waiter && this.final && !this.items.length) this.settle(this.final);
    return step;
  }

  /**
   * Ends the attached response so OpenCode reaches a step boundary and delivers its steer message (§6.14). The
   * turn keeps running; its output is buffered for the next response. False when no response is attached.
   */
  steer(): boolean {
    const waiter = this.waiter;
    if (!waiter || this.final) return false;
    this.detach();
    waiter.resolve({ kind: "steered" });
    return true;
  }

  answer(answers: Answers): void {
    const pending = this.pending;
    this.pending = undefined;
    const report = pending?.resolve(answers) ?? [];
    this.items.unshift(...report.map((delta) => ({ delta })));
    this.drain();
  }

  /** Answers the pending pause and every queued one with no answer, so Devin can end a cancelled turn. */
  abandon(): void {
    this.answer(undefined);
    for (const item of this.items.splice(0)) if ("pause" in item) this.emit(item.pause.resolve(undefined) ?? []);
  }

  private handle(event: TurnEvent): void {
    if (event.kind === "question") return this.askQuestion(event);
    if (event.kind === "permission-ask") return this.askPermission(event);
    this.emit(this.renderer.handle(event));
    for (let card = this.renderer.takeCard(); card; card = this.renderer.takeCard()) {
      this.push({ pause: { card, resolve: () => [] } });
    }
    for (let todos = this.renderer.takeTodos(); todos; todos = this.renderer.takeTodos()) {
      this.push({ pause: { todos, resolve: () => [] } });
    }
  }

  private askQuestion(event: Extract<TurnEvent, { kind: "question" }>): void {
    const form = questionsFromElicitation(event.request);
    const reason = !form ? "the bridge cannot show this kind of question" : !this.offers.question ? "OpenCode did not offer its question tool" : undefined;
    if (reason || !form) {
      event.respond({ action: "cancel" });
      return this.emit(this.renderer.note(`> **Question** cancelled: ${reason}.`));
    }
    this.push({ pause: { form, resolve: (answers) => void event.respond(answers ? elicitationResponse(form, answers) : { action: "cancel" }) } });
  }

  /**
   * Asks through the plugin's native permission check when the request offered it, else through OpenCode's
   * `question` tool. Only the single label "Allow once" or "Always allow this command" allows; the native check
   * reports "Allow once". Anything else rejects, including custom text: Devin's permission reply carries no
   * text. "Always" still answers Devin with `allow_once`; for the native check OpenCode saves its own rule.
   */
  private askPermission(event: Extract<TurnEvent, { kind: "permission-ask" }>): void {
    const { request, reason } = event;
    if (!this.offers.question && !this.offers.permission) {
      event.respond(event.fallback);
      return this.emit(this.renderer.handle({ kind: "permission", request, allowed: false, reason }));
    }
    const form = { fields: [], questions: [permissionQuestion(request, reason)] };
    this.push({
      pause: {
        form,
        permission: nativePermission(request, reason),
        resolve: (answers) => {
          const choice = answers?.[0]?.length === 1 ? answers[0][0] : undefined;
          // OpenCode's own "Always" can come for a call with no exact-command rule (a chained command); it then
          // allows once. In the question, "Always" is offered only when a rule can be saved.
          const always = (choice === PERMISSION_ALWAYS || choice === PERMISSION_NATIVE_ALWAYS) && event.remember !== undefined;
          const allowed = choice === PERMISSION_ALLOW || choice === PERMISSION_NATIVE_ALWAYS || always;
          event.respond(allowed ? allowOnceResponse(request) : event.fallback);
          const report = this.renderer.handle({ kind: "permission", request, allowed, byUser: true });
          return always ? [...report, ...this.renderer.note(this.remember(event.remember!))] : report;
        },
      },
    });
  }

  private remember(save: () => void): string {
    try {
      save();
      return "> **Permission** rule added to the bridge policy file: allow this exact command from now on.";
    } catch (error) {
      return `> **Permission** rule not saved: ${(error as Error).message}`;
    }
  }

  private emit(deltas: Delta[]): void {
    deltas.forEach((delta) => this.items.push({ delta }));
    this.drain();
  }

  private push(item: Item): void {
    this.items.push(item);
    this.drain();
  }

  /** Sends queued output to the attached response until the queue is empty or the turn pauses. */
  private drain(): void {
    while (this.sink && this.waiter && !this.pending && this.items.length) {
      const item = this.items.shift()!;
      if ("delta" in item) this.sink(item.delta);
      else if (item.pause.card && !this.offers.card) this.renderer.cardMarkdown(item.pause.card).forEach(this.sink);
      else if (item.pause.todos && !this.offers.todo) this.renderer.planMarkdown(item.pause.todos).forEach(this.sink);
      else if (item.pause.permission && !this.offers.permission && !this.offers.question) (item.pause.resolve(undefined) ?? []).forEach(this.sink);
      else this.pause(item.pause);
    }
  }

  private pause(pause: Pause): void {
    const callId = this.newCallId();
    const native = pause.permission !== undefined && this.offers.permission === true;
    this.pending = { ...pause, callId, native };
    const waiter = this.waiter!;
    this.detach();
    if (pause.card) waiter.resolve({ kind: "card", callId, card: pause.card });
    else if (pause.todos) waiter.resolve({ kind: "todos", callId, entries: pause.todos });
    else if (native) waiter.resolve({ kind: "permission", callId, permission: pause.permission! });
    else waiter.resolve({ kind: "question", question: { callId, form: pause.form! } });
  }

  private end(final: Final): void {
    this.emit(this.renderer.finish());
    this.final = final;
    if (this.waiter && !this.pending && !this.items.length) this.settle(final);
  }

  private settle(final: Final): void {
    const waiter = this.waiter!;
    this.detach();
    if ("error" in final) waiter.reject(final.error);
    else waiter.resolve(final.step);
  }

  private detach(): void {
    this.sink = undefined;
    this.waiter = undefined;
  }
}
