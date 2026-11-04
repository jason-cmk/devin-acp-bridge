import { describe, expect, test } from "bun:test";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import type { ChatRequest } from "./openai";
import { answerText, elicitationResponse, parseAnswers, questionsFromElicitation, toolResultText } from "./questions";

/** Shape captured from `devin acp` 3000.11.234 for one ask_user_question call with two questions. */
const captured = {
  sessionId: "pleasant-lift",
  mode: "form",
  message: "What is your favourite colour?",
  requestedSchema: {
    type: "object",
    properties: {
      q0: {
        type: "string",
        title: "Colour",
        description: "What is your favourite colour?",
        oneOf: [
          { const: "Red", title: "The colour red" },
          { const: "Green", title: "The colour green" },
          { const: "Blue", title: "The colour blue" },
        ],
      },
      q1: {
        type: "array",
        title: "Fruits",
        description: "Which fruits do you like?",
        minItems: 1,
        items: { anyOf: [{ const: "Apple", title: "Apples" }, { const: "Pear, ripe", title: "Pears" }, { const: "Plum", title: "Plum" }] },
      },
    },
    required: ["q0", "q1"],
  },
  _meta: { "cognition.ai/allowOther": true, "cognition.ai/toolCallId": "toolu_1" },
} as unknown as CreateElicitationRequest;

const form = questionsFromElicitation(captured)!;

describe("questionsFromElicitation", () => {
  test("maps single and multiple choice fields to OpenCode questions", () => {
    expect(form.questions).toEqual([
      {
        question: "What is your favourite colour?",
        header: "Colour",
        options: [
          { label: "Red", description: "The colour red" },
          { label: "Green", description: "The colour green" },
          { label: "Blue", description: "The colour blue" },
        ],
      },
      {
        question: "Which fruits do you like?",
        header: "Fruits",
        options: [
          { label: "Apple", description: "Apples" },
          { label: "Pear, ripe", description: "Pears" },
          { label: "Plum", description: "" },
        ],
        multiple: true,
      },
    ]);
  });

  test("maps booleans to Yes/No, free text to no options, and clips long headers", () => {
    const request = {
      sessionId: "s",
      mode: "form",
      message: "Fallback question",
      requestedSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean", title: "A header that is much longer than thirty characters" },
          name: { type: "string" },
          count: { type: "integer", description: "How many?" },
          kind: { type: "string", enum: ["a", "b"] },
        },
      },
    } as unknown as CreateElicitationRequest;
    expect(questionsFromElicitation(request)?.questions).toEqual([
      {
        question: "A header that is much longer than thirty characters",
        header: "A header that is much longer …",
        options: [
          { label: "Yes", description: "" },
          { label: "No", description: "" },
        ],
      },
      { question: "Fallback question", header: "Question 2", options: [] },
      { question: "How many?", header: "Question 3", options: [] },
      {
        question: "Fallback question",
        header: "Question 4",
        options: [
          { label: "a", description: "" },
          { label: "b", description: "" },
        ],
      },
    ]);
  });

  test("returns undefined for URL mode and for forms without fields", () => {
    expect(questionsFromElicitation({ sessionId: "s", mode: "url", url: "https://x", elicitationId: "e", message: "m" } as unknown as CreateElicitationRequest)).toBeUndefined();
    expect(questionsFromElicitation({ sessionId: "s", mode: "form", message: "m", requestedSchema: {} } as unknown as CreateElicitationRequest)).toBeUndefined();
  });
});

describe("parseAnswers", () => {
  test("reads OpenCode's answer text, including labels that contain the separator and custom answers", () => {
    const text = answerText(form.questions, [["My own colour"], ["Apple", "Pear, ripe", "Kiwi, gold"]]);
    expect(text).toBe(
      'User has answered your questions: "What is your favourite colour?"="My own colour", "Which fruits do you like?"="Apple, Pear, ripe, Kiwi, gold". You can now continue with the user\'s answers in mind.',
    );
    expect(parseAnswers(text, form.questions)).toEqual([["My own colour"], ["Apple", "Pear, ripe", "Kiwi, gold"]]);
  });

  test("treats Unanswered as no answer", () => {
    expect(parseAnswers(answerText(form.questions, [["Red"], []]), form.questions)).toEqual([["Red"], []]);
  });

  test("returns undefined for any other tool result, such as a dismissal message", () => {
    expect(parseAnswers("The user dismissed this question", form.questions)).toBeUndefined();
  });
});

describe("elicitationResponse", () => {
  test("accepts with values typed to each field", () => {
    expect(elicitationResponse(form, [["Red"], ["Apple", "Plum"]])).toEqual({ action: "accept", content: { q0: "Red", q1: ["Apple", "Plum"] } });
  });

  test("converts booleans and numbers and leaves out unanswered or invalid fields", () => {
    const typed = questionsFromElicitation({
      sessionId: "s",
      mode: "form",
      message: "m",
      requestedSchema: { properties: { ok: { type: "boolean" }, n: { type: "number" }, i: { type: "integer" }, s: { type: "string" } } },
    } as unknown as CreateElicitationRequest)!;
    expect(elicitationResponse(typed, [["Yes"], ["2.5"], ["many"], []])).toEqual({ action: "accept", content: { ok: true, n: 2.5 } });
  });
});

describe("toolResultText", () => {
  const request = (messages: ChatRequest["messages"]): ChatRequest => ({ messages });

  test("returns the text of the trailing tool message for the call", () => {
    expect(
      toolResultText(
        request([
          { role: "user", content: "hi" },
          { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "question", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "answer" }] },
        ]),
        "call_1",
      ),
    ).toBe("answer");
  });

  test("skips harness messages that OpenCode appends after the tool result", () => {
    expect(
      toolResultText(
        request([
          { role: "tool", tool_call_id: "call_1", content: "answer" },
          { role: "user", content: "<system-update>\nThe Code Mode tool catalog has changed.\n</system-update>" },
        ]),
        "call_1",
      ),
    ).toBe("answer");
  });

  test("returns undefined when the request ends with a user message or another call", () => {
    expect(toolResultText(request([{ role: "tool", tool_call_id: "call_1", content: "a" }, { role: "user", content: "new" }]), "call_1")).toBeUndefined();
    expect(toolResultText(request([{ role: "tool", tool_call_id: "call_2", content: "a" }]), "call_1")).toBeUndefined();
  });
});
