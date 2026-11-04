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
- `npm` or [Bun](https://bun.sh) once, to install dependencies. At runtime the bridge uses the Bun that is built
  into OpenCode.
- macOS or Linux.

## Set up

The OpenCode plugin runs the bridge for you, the way an editor runs a language server. You never start it by
hand.

### 1. Install

```bash
git clone https://github.com/jason-cmk/devin-acp-bridge.git ~/src/devin-acp-bridge
cd ~/src/devin-acp-bridge
npm install        # or: bun install
```

### 2. Configure OpenCode

Add this to `~/.config/opencode/opencode.jsonc` (every project) or to a project's `opencode.jsonc`. Replace the
path.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/devin-acp-bridge/opencode-plugin"],
  "agents": {
    "devin": {
      "description": "Send prompts to Devin through the local ACP bridge",
      "mode": "primary",
      // Safety net: OpenCode's own edit and shell tools stay off. Devin uses its own.
      "permissions": [
        { "action": "edit", "resource": "*", "effect": "deny" },
        { "action": "shell", "resource": "*", "effect": "deny" }
      ]
    }
  },
  "compaction": { "auto": false }
}
```

Do not add a `"model"` to the `devin` agent: it overrides the model you pick in `/models`. Do not define a
`devin` provider yourself: the plugin registers it.

### 3. Restart OpenCode and use it

```bash
opencode service restart   # loads the plugin in the background service
opencode
```

Switch to the `devin` agent and pick a `devin/…` model in `/models`. Check that it works without the TUI:

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
- When the bridge source in `src/` changes (for example after `git pull`), it stops the old bridge and starts
  the new one. Changes to the plugin itself (`opencode-plugin/`) take effect after `opencode service restart`.
- On first load it waits up to 20 seconds for the bridge and its model list before OpenCode continues.
- The bridge keeps running as long as the OpenCode service. `opencode service stop` does not stop it; stop it
  with `kill $(jq .pid ~/.cache/devin-acp-bridge/bridge.json)`.

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

Add the `devin` agent from step 2 as well. In this mode the plugin only refreshes the model list.

## What you see

- Devin's reply as normal OpenCode markdown, and its thinking as reasoning blocks.
- One line per tool call, for example `> **Read file** \`src/app.ts\`` or `> **Run** \`git status\``.
- Shell output (first 20 lines) and non-zero exit codes.
- File edits as `diff` blocks.
- Devin's plan at the start of a turn, and again at the end if it changed.
- Permission decisions, for example `> **Permission** rejected: \`rm -rf build\``.
- Token usage for each turn, as Devin reports it.

## Choose a model

`/models` lists Devin's current models under `devin/…`. The plugin fetches the
list from the bridge when OpenCode starts and every 5 minutes, so new Devin models appear without a config
change. `devin/devin` means Devin's default model.

Each model runs at the thought level its ID names (`claude-opus-5-5-medium`, `swe-2-high`). You can switch
models in the middle of a conversation; the next turn uses the new model.

Plugin options (use the object form in `plugins`):

```jsonc
"plugins": [
  {
    "package": "/absolute/path/to/devin-acp-bridge/opencode-plugin",
    "options": {
      "exclude": ["fusion-*"],   // default: hide Devin's fusion combinations
      "refreshMinutes": 5,       // default
      "provider": "devin"        // default provider ID
      // "baseURL": "http://127.0.0.1:7317/v1"  — set only when you run the bridge yourself
    }
  }
]
```

## Permissions

Devin decides first, using its own permission rules (`~/.config/devin/config.json`). It asks the bridge only
about calls those rules do not cover. In its default mode Devin edits files without asking and asks before
shell commands and other tools.

The bridge cannot show an approval prompt in OpenCode, so it **rejects every request** unless a policy rule
allows it. Create `~/.config/devin-acp-bridge/policy.json`:

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
  not approve `git status && rm -rf ~`.
- The bridge reads the file on every request, so edits apply without a restart.

## Configuration

Environment variables are read by the bridge. In managed mode it inherits them from the OpenCode service.

| Variable | Default | Effect |
| --- | --- | --- |
| `DEVIN_BRIDGE_PORT` | `7317` (manual), random (managed) | Port on `127.0.0.1`. In manual mode, update `baseURL` to match. |
| `DEVIN_BRIDGE_TOKEN` | token file | Use this token instead of `~/.config/devin-acp-bridge/token`. OpenCode must send the same value. |
| `DEVIN_BRIDGE_POLICY` | `~/.config/devin-acp-bridge/policy.json` | Permission policy file. |
| `DEVIN_BRIDGE_DEBUG` | off | `1` writes all ACP traffic, including prompts and replies, to `~/.cache/devin-acp-bridge/bridge-debug.ndjson`, and plugin debug lines to `opencode-plugin.log`. |

`GET http://127.0.0.1:<port>/healthz` (no token) reports the bridge's PID and build, whether Devin is running,
how many sessions the bridge holds and how many turns are running. In managed mode the port is in `~/.cache/devin-acp-bridge/bridge.json`.

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
| No `devin/…` models at all | The plugin did not load or could not start the bridge. Check `~/.cache/devin-acp-bridge/opencode-plugin.log` and `bridge.log`, check that `npm install` ran in the repo, then run `opencode service restart`. |
| Only `devin/devin` in `/models` | The bridge answered but Devin's model list failed. Check `devin auth login`, then `opencode-plugin.log`. |
| Two `devin` providers, or requests go to the wrong port | You defined a `devin` provider in config and also use managed mode. Remove the provider, or set `baseURL` in the plugin options for manual mode. |
| OpenCode reports a missing API key or the bridge returns 401 (manual mode) | OpenCode is not sending the bridge token. Use `"apiKey": "{file:~/.config/devin-acp-bridge/token}"` and run `opencode service restart`. If you set `DEVIN_BRIDGE_TOKEN` for the bridge, OpenCode needs the same value. |
| `Error: Failed to start server. Is port 7317 in use?` (manual mode) | Another bridge is running. Stop it or set `DEVIN_BRIDGE_PORT`. |
| Devin reads or edits the wrong directory (manual mode) | Set `X-Devin-Cwd` to the project's absolute path. Managed mode sets it per project. |
| Every shell command is rejected | Expected without a policy file. Add an `allow` rule, or allow it in Devin's own config. |
| `_The bridge could not complete the Devin turn: …_` | `devin acp` stopped. The next prompt starts it again and replays the conversation. Details are in `~/.cache/devin-acp-bridge/devin-acp.log`. |

## Limitations

- Undo and revert in OpenCode change the transcript only, not Devin's file edits. Use git.
- No approval prompts inside OpenCode; use the policy file.
- Image attachments are not sent to Devin.
- Thought levels other than each model's default are not selectable.
- Editing or retrying a message in OpenCode moves the conversation to a new Devin session with the earlier
  turns replayed as text.
- Bridge sessions appear in Devin's own session list.

## Development

`bun run typecheck`, `bun test`. To pick up bridge changes (`src/`) in managed mode, save the files: the plugin
replaces the bridge on its next refresh, or at once after `opencode service restart`. Plugin changes
(`opencode-plugin/`) need `opencode service restart`.
Design, milestones and findings are in [docs/spec.md](docs/spec.md); a visual overview is in
[docs/architecture.html](docs/architecture.html); contributor notes, including how to run end-to-end checks on a second port, are in [AGENTS.md](AGENTS.md).
