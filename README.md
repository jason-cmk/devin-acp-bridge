# devin-acp-bridge

Use [Devin](https://devin.ai) from the [OpenCode](https://opencode.ai) terminal UI.

The bridge runs `devin acp` (Devin's Agent Client Protocol server) and exposes it to OpenCode as an
OpenAI-compatible model on `127.0.0.1`. Devin does the work with its own tools, login and rules; OpenCode
renders the conversation — markdown, highlighted code, tool activity, diffs and plans.

```text
OpenCode TUI ──HTTP (OpenAI chat API)──▶ devin-acp-bridge ──ACP over stdio──▶ devin acp
```

No fork of OpenCode and no change to Devin. Personal tooling, not a supported product: it relies on the
public interfaces of both tools, which can change.

## Requirements

- [Devin CLI](https://docs.devin.ai) installed and logged in (`devin auth login`). Tested with 3000.11.234.
- [OpenCode](https://opencode.ai) v2. Tested with 2.2.5.
- For a clone install only: `npm` or [Bun](https://bun.sh) once, to install dependencies. At runtime the bridge
  uses the Bun that is built into OpenCode.
- macOS or Linux.

## Set up

The OpenCode plugin runs the bridge for you, the way an editor runs a language server. You never start it by
hand.

### 1. Install

Either let OpenCode install it from GitHub (no clone, no `npm`):

```bash
opencode plugin add github:jason-cmk/devin-acp-bridge
```

This installs the package in OpenCode's cache and adds `"github:jason-cmk/devin-acp-bridge"` to `plugins` in
`~/.config/opencode/opencode.json`. To update later, run `opencode plugin add` again (see "Update" below).

Or clone it, if you want to change the code:

```bash
git clone https://github.com/jason-cmk/devin-acp-bridge.git ~/src/devin-acp-bridge
cd ~/src/devin-acp-bridge
npm install        # or: bun install
```

### 2. Configure OpenCode

Add this to `~/.config/opencode/opencode.jsonc` (every project) or to a project's `opencode.jsonc`. With
`opencode plugin add`, the `plugins` entry is already in the global config; add only the rest. With a clone,
replace the path. Use one copy of the plugin only: a GitHub install and a clone path both loaded give two
plugins that fight over the `devin` provider.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/devin-acp-bridge/opencode-plugin"],   // or "github:jason-cmk/devin-acp-bridge"
  "compaction": { "auto": false },
  // Devin's plan in OpenCode's todo list and sidebar panel. Without it the plan shows as a checklist.
  "experimental": { "todo": true }
}
```

Do not define a `devin` provider yourself: the plugin registers it. You need no extra agent: use OpenCode's
`build` and `plan` agents (see [Devin mode per OpenCode agent](#devin-mode-per-opencode-agent)). Devin runs its
own tools, so OpenCode's edit and shell tools are never called.

### 3. Restart OpenCode and use it

```bash
opencode service restart   # loads the plugin in the background service
opencode
```

Pick a `devin/…` model in `/models`. Use `build` for normal work and `plan` for read-only work (Tab switches).
Check that it works without the TUI:

```bash
opencode run -m devin/devin "Reply with READY only. Do not use any tools."
```

### What the plugin does

- On the first OpenCode project that loads it, it starts **one** bridge for the machine on a random port, using
  OpenCode's own binary as Bun (`BUN_BE_BUN=1`). Other projects reuse it. Its state is in
  `~/.cache/devin-acp-bridge/bridge.json` and its log in `bridge.log` next to it.
- It registers the `devin` provider for each project, with that project's directory as Devin's working
  directory, and Devin's live model list.
- It creates the bridge token in `~/.config/devin-acp-bridge/token` and passes it to the provider.
- Every 5 minutes it checks the bridge, restarts it if it stopped, and refreshes the model list.
- When the bridge source in `src/` changes (after `git pull` or a plugin update), it stops the old bridge and
  starts the new one. Changes to the plugin itself (`opencode-plugin/`) take effect after `opencode service restart`.
- On first load it waits up to 20 seconds for the bridge and its model list before OpenCode continues.
- The bridge keeps running as long as the OpenCode service. `opencode service stop` does not stop it; stop it
  with `kill $(jq .pid ~/.cache/devin-acp-bridge/bridge.json)`.

### Update

- GitHub install: `opencode plugin update` and a second `opencode plugin add` do not fetch new commits of a
  Git plugin. Delete OpenCode's cached copy instead; OpenCode installs the latest commit on its next start:

  ```bash
  rm -rf ~/.cache/opencode/npm/git-devin-acp-bridge-*
  opencode service restart
  ```

- Clone: `git pull`, then `npm install` if `package.json` changed, then `opencode service restart`.

The plugin then replaces the running bridge with the new build.

## Run the bridge yourself (optional)

Use this if you do not use OpenCode's service, or want the bridge on a fixed port.

```bash
bun run start      # http://127.0.0.1:7317; DEVIN_BRIDGE_PORT changes the port
```

Then set `baseURL` in the plugin options, which turns off managed mode, and define the provider yourself:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/devin-acp-bridge/opencode-plugin", "options": { "baseURL": "http://127.0.0.1:7317/v1" } }
  ],
  "providers": {
    "devin": {
      "name": "Devin (ACP bridge)",
      "package": "@opencode/ai/providers/openai-compatible",
      // Devin's working directory. Use the project's absolute path.
      "headers": { "X-Devin-Cwd": "/absolute/path/to/your/project" },
      "settings": {
        "baseURL": "http://127.0.0.1:7317/v1",
        "apiKey": "{file:~/.config/devin-acp-bridge/token}",
        // Devin turns can be quiet for a long time while tools run.
        "chunkTimeout": false
      },
      "models": {
        "devin": {
          "name": "Devin",
          "compatibility": { "reasoningField": "reasoning_content" },
          "limit": { "context": 1000000, "output": 128000 }
        }
      }
    }
  }
}
```

In this mode the plugin only refreshes the model list.

## What you see

- Devin's reply as normal OpenCode markdown, and its thinking as reasoning blocks.
- One line per tool call, for example `> **Read file** \`src/app.ts\`` or `> **Run** \`git status\``.
- Shell output (first 20 lines) and non-zero exit codes.
- File edits as `diff` blocks.
- Devin's plan in OpenCode's own todo list and sidebar panel, updated each time the plan changes. This needs
  `"experimental": { "todo": true }` in your OpenCode config; without it the plan shows as a checklist in the
  reply, at the start of a turn and again at the end if it changed.
- Permission decisions, for example `> **Permission** rejected by bridge policy (reject rule): \`rm -rf build\``
  or `> **Permission** allowed by you: \`npm test\``. Devin tells its model that "the user" rejected the call,
  even when the bridge policy rejected it. A decision made in OpenCode's own permission dialog shows as
  `✓ permission [title=Run npm test]` or `✗ permission […]`, with no extra line.
- Token usage for each turn, as Devin reports it, including cache reads. Cache writes stay in the input count,
  because OpenCode's OpenAI-compatible provider has no field for them.
- Devin's questions in OpenCode's own question picker. Devin waits for your answer and then continues the same
  turn. If you type a new message instead, the bridge cancels the question and Devin's turn, then sends your
  message. The agent must allow OpenCode's `question` tool; otherwise the bridge cancels the question and says
  so in the reply.
- Devin's own session title in OpenCode's session list. It arrives a few seconds after your first message.
- Attached images. Devin sees images on your newest message.
- Devin's slash commands as `/devin:<name>`, for example `/devin:compact` or `/devin:recap`, and Devin's skills.
  Set the plugin option `"commands": false` to hide them.
- Messages you type while Devin works go to the running turn, and Devin reads them at its next step, as in the
  Devin CLI. Queued messages (OpenCode's queue delivery) still wait until the turn ends.
- With the plugin option `"toolCards": true` (experimental), each Devin tool call shows the way OpenCode shows
  its own tools: `$ git status` with the output, `← Edit src/a.ts` with the diff, reads and searches under
  `→ Explored`, and MCP calls as `✓ <server>_<tool> [key=value]`. OpenCode does not run these tools again; the
  plugin sends each card to a tool that does nothing.

## Choose a model

`/models` lists Devin's current models under `devin/…`. The plugin fetches the
list from the bridge when OpenCode starts and every 5 minutes, so new Devin models appear without a config
change. `devin/devin` means Devin's default model.

Each model runs at the thought level its ID names (`claude-opus-5-5-medium`, `swe-2-high`) unless you pick a
variant: each thought level the model supports is an OpenCode variant, for example
`-m devin/claude-sonnet-5-5-medium#high` or the variant picker in the TUI. The variants appear about a minute
after the bridge starts, while it reads the levels from Devin (no billed turn). You can switch models and
variants in the middle of a conversation; the next turn uses the new choice.

Plugin options (use the object form in `plugins`):

```jsonc
"plugins": [
  {
    "package": "/absolute/path/to/devin-acp-bridge/opencode-plugin",   // or "github:jason-cmk/devin-acp-bridge"
    "options": {
      "exclude": ["fusion-*"],   // default: hide Devin's fusion combinations
      "refreshMinutes": 5,       // default
      "provider": "devin",       // default provider ID
      "commands": true,          // default: Devin's slash commands as /devin:<name>
      "toolCards": false,        // default: true shows Devin's tool calls as OpenCode tool cards (experimental)
      "nativePermissions": true, // default: Devin's permission prompts use OpenCode's own permission dialog
      "debug": false             // default: true runs the managed bridge with DEVIN_BRIDGE_DEBUG=1 (logs prompts)
      // "baseURL": "http://127.0.0.1:7317/v1"  — set only when you run the bridge yourself
    }
  }
]
```

## Permissions

Devin decides first, using its own permission rules (`~/.config/devin/config.json`). It asks the bridge only
about calls those rules do not cover. In its default mode Devin edits files without asking and asks before
shell commands and other tools.

The bridge checks its policy file first. When no rule matches, it **asks you** in OpenCode's own permission
dialog, as for OpenCode's built-in tools: a shell command shows as **Shell command** with the command, an MCP
tool as **Call tool** with its name.

- **Allow once** allows this call.
- **Always allow** allows this call and adds an `allow` rule for that exact command to the bridge policy file,
  so the next identical command runs with no prompt. OpenCode offers it only for a plain command: a chained
  command (`&&`, `|`, `;`, …) gets only **Allow once** and **Reject**.
- **Reject** rejects the call and stops the reply, as for OpenCode's own tools. Devin's turn waits; your next
  message cancels it and starts a new one.
- `opencode --auto` (auto-accept) allows Devin's calls too.

OpenCode's own `permission` rules do not allow Devin's calls: OpenCode's agents allow every action by default,
so the plugin turns any `allow` for a Devin call into a prompt. A `deny` rule still denies. Put allow rules in
the bridge policy file instead.

With the plugin option `"nativePermissions": false`, the bridge asks in OpenCode's question picker instead:
**Allow once**, **Always allow this command** or **Reject**, with the command, Devin's rule and why no policy
rule allowed it. Dismissing the picker, typing a new message or the timeout rejects. If the agent does not
allow OpenCode's `question` tool either, the bridge rejects at once.

To skip the prompt for commands you trust or never want, create `~/.config/devin-acp-bridge/policy.json`:

```json
{
  "rules": [
    { "command": "git push*", "decision": "reject" },
    { "command": "git *", "decision": "allow" },
    { "command": "dotnet test*", "decision": "allow" }
  ]
}
```

- `command` matches the shell command, `rule` matches Devin's permission rule (for example `Exec(dotnet)`),
  `title` matches the tool title. Only `*` is special. The first matching rule wins.
- `allow` approves that one call only. The bridge never chooses Devin's "always allow" or "bypass" options.
- `allow` never covers a chained command (`;`, `&`, `|`, `<`, `>`, backticks, `$(`, newlines): `git *` does
  not approve `git status && rm -rf ~`. The bridge asks you about it instead.
- `reject` never prompts.
- The bridge reads the file on every request, so edits apply without a restart.

### Devin mode per OpenCode agent

The plugin tells the bridge which OpenCode agent sent each request. The bridge sets Devin's session mode to
match before the turn:

| OpenCode agent | Devin mode | Effect |
| --- | --- | --- |
| `build` | `accept-edits` | Edits apply; other tools ask; the policy file decides, then you. |
| `plan` | `plan` | Devin's plan mode, for read-only work. Calls that Devin asks about still go through the policy file, then to you. |
| `devin-bypass` | `bypass` | Devin runs every tool without asking. **The policy file, the chained-command guard and permission prompts do not apply.** |
| any other | `accept-edits` | Devin's default: edits apply, other tools ask; the policy file decides, then you. |

Switching agents in the middle of a conversation changes the mode for the next turn. Leaving `devin-bypass`
for any other agent ends `bypass` on the next turn. OpenCode's `--auto` flag allows the calls Devin asks about,
but Devin still runs in `accept-edits` mode and the bridge policy file still rejects its `reject` rules.

`devin-bypass` is opt-in: the bridge uses `bypass` only for an agent with that exact name. To use it, add it
under `"agents"` and switch to it (Tab) only in a project where you accept that Devin runs shell commands with
no check:

```jsonc
"agents": {
  "devin-bypass": {
    "description": "Devin through the bridge in bypass mode: no permission checks",
    "mode": "primary"
  }
}
```

You can also define your own agent for Devin, for example to set a `steps` limit for tool cards. Do not give it
a `"model"`: that overrides the model you pick in `/models`. The bridge treats it like `build`.

## Configuration

Environment variables are read by the bridge. In managed mode it inherits them from the OpenCode service.

| Variable | Default | Effect |
| --- | --- | --- |
| `DEVIN_BRIDGE_PORT` | `7317` (manual), random (managed) | Port on `127.0.0.1`. In manual mode, update `baseURL` to match. |
| `DEVIN_BRIDGE_TOKEN` | token file | Use this token instead of `~/.config/devin-acp-bridge/token`. OpenCode must send the same value. |
| `DEVIN_BRIDGE_POLICY` | `~/.config/devin-acp-bridge/policy.json` | Permission policy file. |
| `DEVIN_BRIDGE_QUESTION_TIMEOUT_MS` | `600000` (10 min) | How long Devin waits for the answer to a question or a permission prompt. After that the bridge cancels the question (or rejects the permission) and the turn. |
| `DEVIN_BRIDGE_DEBUG` | off | `1` writes all ACP traffic, including prompts and replies, to `~/.cache/devin-acp-bridge/bridge-debug.ndjson`, and plugin debug lines to `opencode-plugin.log`. |

`GET http://127.0.0.1:<port>/healthz` (no token) reports the bridge's PID and build, whether Devin is running,
how many sessions the bridge holds, how many turns are running and how many wait for an answer to a question. In managed mode the port is in `~/.cache/devin-acp-bridge/bridge.json`.

## Security

- The bridge listens on `127.0.0.1` only.
- Every API request needs the bridge token. The token is a local password between OpenCode and the bridge; it
  is not a Devin credential and never leaves your machine. To rotate it, delete the file and restart the bridge.
- The bridge never reads your Devin credentials. `devin acp` uses its own `devin auth login` store.
- Every prompt is a Devin turn on your account. Usage and cost are Devin's.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| OpenCode is slow to start the first time | Expected: the plugin waits up to 20 seconds while it starts the bridge and reads Devin's model list. Later starts reuse the running bridge. |
| No `devin/…` models at all | The plugin did not load or could not start the bridge. Check `~/.cache/devin-acp-bridge/opencode-plugin.log` and `bridge.log`, for a clone install check that `npm install` ran in the repo, then run `opencode service restart`. |
| Only `devin/devin` in `/models` | The bridge answered but Devin's model list failed. Check `devin auth login`, then `opencode-plugin.log`. |
| Only `devin/devin`, and the plugin is in both the global and the project config with different paths | Two copies of the plugin are loaded. Keep one. |
| Two `devin` providers, or requests go to the wrong port | You defined a `devin` provider in config and also use managed mode. Remove the provider, or set `baseURL` in the plugin options for manual mode. |
| OpenCode reports a missing API key or the bridge returns 401 (manual mode) | OpenCode is not sending the bridge token. Use `"apiKey": "{file:~/.config/devin-acp-bridge/token}"` and run `opencode service restart`. If you set `DEVIN_BRIDGE_TOKEN` for the bridge, OpenCode needs the same value. |
| `Error: Failed to start server. Is port 7317 in use?` (manual mode) | Another bridge is running. Stop it or set `DEVIN_BRIDGE_PORT`. |
| Devin reads or edits the wrong directory (manual mode) | Set `X-Devin-Cwd` to the project's absolute path. Managed mode sets it per project. |
| Every shell command is rejected with no prompt | You use `opencode run`, which cannot ask, or the plugin is not loaded and the agent does not allow OpenCode's `question` tool. Add an `allow` rule to the bridge policy file, or allow it in Devin's own config. |
| A second permission prompt appears right after the first | Devin asked for two permissions. The bridge asks them one at a time, in order. |
| `Devin rejected thought_level …` | The variant names a level the model lacks and the bridge did not know the model's levels yet. Pick the model's default variant, or wait a minute and retry. |
| No `/devin:` commands | The plugin reads them after the models; wait for the next refresh, or check `opencode-plugin.log`. `opencode run "/devin:…"` does not run commands; use the TUI. |
| `> **Question** cancelled: OpenCode did not offer its question tool.` | The agent denies OpenCode's `question` permission. Allow it for the agent you use with Devin. |
| Devin's question shows as failed with "User canceled the question" | You dismissed the picker, typed a new message, or the answer timed out (`DEVIN_BRIDGE_QUESTION_TIMEOUT_MS`). `opencode run` cannot ask questions, so it always cancels them. |
| `_The bridge could not complete the Devin turn: …_` | `devin acp` stopped. The next prompt starts it again and replays the conversation. Details are in `~/.cache/devin-acp-bridge/devin-acp.log`. |

## Limitations

- Undo and revert in OpenCode also revert Devin's file edits, because OpenCode snapshots the worktree around
  each reply. Gitignored files are not in the snapshot.
- OpenCode's `/compact` costs no Devin turn: the bridge answers OpenCode's summary request itself and keeps the
  same Devin session, which compacts its own context. To compact Devin's context now, use `/devin:compact`.
- Editing, retrying or reverting a message moves the conversation to a new Devin session with the earlier
  turns replayed as text. Devin offers no way over ACP to fork or rewind a session.
- Devin's plan reaches the todo panel only with `"experimental": { "todo": true }`, an experimental OpenCode
  option. Each plan change is one more OpenCode step.
- Tool cards (`toolCards`) add one OpenCode step per Devin tool call. An agent step limit can end a long turn
  early.
- Bridge sessions appear in Devin's own session list.

## Development

`bun run typecheck`, `bun test`. To pick up bridge changes (`src/`) in managed mode, save the files: the plugin
replaces the bridge on its next refresh, or at once after `opencode service restart`. Plugin changes
(`opencode-plugin/`) need `opencode service restart`.
Design, milestones and findings are in [docs/spec.md](docs/spec.md); a visual overview is in
[docs/architecture.html](docs/architecture.html); contributor notes, including how to run end-to-end checks on a second port, are in [AGENTS.md](AGENTS.md).
