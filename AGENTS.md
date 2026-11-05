# AGENTS.md

Local bridge that lets the OpenCode TUI use Devin (`devin acp`) as an OpenAI-compatible model.
`docs/spec.md` is the source of truth for design, milestones and findings. Update its §8 milestone table and
§11 findings when behaviour changes. `README.md` is the setup guide for people the bridge is shared with; keep
its OpenCode config, options table and troubleshooting in step with the code.

## Layout

- `src/server.ts` — HTTP/SSE, auth, session planning, turn lifecycle.
- `src/devin.ts` — one `devin acp` child and the ACP client.
- `src/render.ts` — ACP updates → markdown deltas (tool lines, shell output, diffs, plans, usage).
- `src/sessions.ts` — OpenCode → Devin session mapping and transcript replay.
- `src/turn.ts` — one Devin prompt turn that can pause on a question or permission prompt and resume in a
  later HTTP request.
- `src/questions.ts` — ACP `elicitation/create` form ↔ OpenCode `question` tool call and answer text.
- `src/modes.ts` — OpenCode agent (`x-opencode-agent`) → Devin session mode (`build` → `accept-edits`, `plan` → `plan`).
- `src/permissions.ts` — policy file, permission decisions, the permission prompt text and "Always allow" rules.
- `src/titles.ts` — Devin's session title for OpenCode's title request.
- `src/commands.ts` — Devin slash commands exposed as `/devin:<name>`.
- `src/models.ts` — Devin model catalog from ACP config options; exclude filter.
- `src/auth.ts`, `src/diff.ts`, `src/glob.ts`, `src/openai.ts` — token, unified diff, glob, OpenAI helpers.
- `src/managed.ts` — plugin-managed bridge: build ID, state/lock files in `~/.cache/devin-acp-bridge/`,
  `ensureBridge` (starts `BUN_BE_BUN=1 <opencode> run src/server.ts` on port 0).
- `opencode-plugin/index.ts` — OpenCode server plugin. Managed mode (default): starts the shared bridge and
  registers the `devin` provider per project with `ctx.provider.transform`. Manual mode (`baseURL` option):
  replaces the config provider's models with `ctx.model.transform`, because provider transforms cannot see
  providers from `opencode.jsonc`. One plugin instance runs per project directory and instances share no memory.
  It logs to `~/.cache/devin-acp-bridge/opencode-plugin.log` (debug lines only with `DEVIN_BRIDGE_DEBUG=1`).

## Commands

- `bun run typecheck` — must exit 0.
- `bun test` — unit tests in `src/*.test.ts`.
- `bun run start` — bridge on `127.0.0.1:7317` (`DEVIN_BRIDGE_PORT` overrides).
- `bun run stub` — M0 logging stub on the same port; writes raw OpenCode requests to `captures/` (gitignored).
- `bun run stub/probe.ts <abs-cwd>` — runs `devin acp` `initialize` and `session/new` only (no prompt).
- `bun run stub/probe-models.ts <abs-cwd> [model…]` — prints model names and how `thought_level` changes per
  model, then deletes the session (no prompt).
- `bun run stub/probe-elicitation.ts <abs-cwd>` — one billed turn; prints Devin's raw `elicitation/create`
  payload and accepts the first option.
- `DEVIN_BRIDGE_TOKEN=e2e-token bun run stub/question-flow.ts 7318 [--move-on] [--permission[=reject]]` — one
  or two billed turns against the e2e bridge; plays OpenCode's side of a question (answer, or a new message
  with `--move-on`), or of a permission prompt for an unmatched `touch /tmp/devin-bridge-ask-*`.
- `stub/question-flow.ts … --permission=always` — the same, answering "Always allow"; point
  `DEVIN_BRIDGE_POLICY` at a copy of `e2e/policy.json` first, because it appends a rule.
- `stub/question-flow.ts … --permission=two` — asks for two parallel commands; allows `-a`, rejects `-b`.
- `DEVIN_BRIDGE_TOKEN=e2e-token bun run stub/title-flow.ts 7318` — one billed turn; sends the chat and title
  requests together and prints Devin's title.
- `DEVIN_BRIDGE_TOKEN=e2e-token bun run stub/steer-flow.ts 7318` — one billed turn; steers a running turn.
- `bun run stub/probe-steer.ts <abs-cwd>` — one billed turn; raw ACP mid-turn `session/prompt`.
- Plugin features (commands, steering, tool cards, revert) need a real OpenCode server: run
  `opencode serve --hostname 127.0.0.1 --port 4917` in `e2e/`, read the password from its output, and call
  `/api/session`, `/api/session/<id>/prompt` (`delivery: "steer"`), `/api/session/<id>/command`,
  `/api/session/<id>/message` and `/api/session/<id>/revert/{stage,commit}` with `curl -u opencode:<password>`
  and `x-opencode-directory`. `opencode run` does not run plugin commands.
- `opencode --standalone models` from `e2e/` (with the e2e bridge running) — confirms the plugin loaded.
- `opencode --standalone models` from `managed-e2e/project-a` — starts a managed bridge (see
  `~/.cache/devin-acp-bridge/bridge.json`). Stop it afterwards with `kill $(jq .pid …/bridge.json)`; it is
  detached and outlives the command.

## End-to-end check

The user may have a bridge running on 7317. Use the `e2e/` project, which points at port 7318 and has its own
policy file:

```bash
DEVIN_BRIDGE_PORT=7318 DEVIN_BRIDGE_TOKEN=e2e-token \
  DEVIN_BRIDGE_POLICY="$PWD/e2e/policy.json" bun run start
# from e2e/
DEVIN_BRIDGE_TOKEN=e2e-token opencode --standalone run --format json "<prompt>"
DEVIN_BRIDGE_TOKEN=e2e-token opencode --standalone run --format json --continue "<follow-up>"
```

`--standalone` keeps the user's OpenCode background service out of the test. An agent's shell tool may stop
background processes when its call ends; start the bridge, run the test and stop the bridge in one command. Each run is a billed Devin turn;
keep prompts small and tell Devin not to use tools unless the test needs them. `e2e/scratch.txt` is a
gitignored file for edit tests.

## Rules

- Pin dependencies to exact versions published at least 7 days earlier.
- Never auto-approve a Devin permission request by position: Devin offers `switch_bypass` as an
  `allow_always` option. Allow rules select `allow_once` only and never cover chained shell commands.
- Logs: Devin's stderr goes to `~/.cache/devin-acp-bridge/devin-acp.log`. `DEVIN_BRIDGE_DEBUG=1` writes ACP
  traffic, including prompt text, to `bridge-debug.ndjson` in the same directory. Use it to capture new update
  shapes before changing `render.ts`.
