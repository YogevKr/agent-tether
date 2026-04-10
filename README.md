# Agent Tether

Run coding agents on your machine as usual. Global Codex and Claude Code hooks index sessions locally. Telegram lets you bind one of those sessions to a forum topic and continue it remotely.

## Model

- Local Codex and Claude Code sessions are indexed by global hooks.
- Telegram General topic is the main control plane.
- Telegram DM remains available as fallback control.
- A Telegram forum topic is the work surface for one agent session.
- Sessions stay headless until you bind one from `/sessions`.
- Sessions are owned by one `host_id`, so one bot can route work to multiple computers.
- Telegram can also create a fresh session: choose node, choose place, browse directories, open topic, send first prompt.
  Before node/place selection, Telegram asks which provider to use for the new session.

## Requirements

- Node 20+
- `codex` and/or `claude` CLI installed and logged in
- Telegram bot token from BotFather
- A Telegram supergroup with Topics enabled
- The bot added to that supergroup as admin with topic management rights
- Global agent hooks enabled in `~/.codex` and `~/.claude`

## Setup

1. Copy env file:

   ```bash
   cp .env.example .env
   ```

2. Fill these values in `.env`:

   - `TELEGRAM_BOT_TOKEN`
   - `AUTHORIZED_TELEGRAM_USER_IDS`
   - `TELEGRAM_FORUM_CHAT_ID`
   - `CODEX_DEFAULT_CWD`
   - `RELAY_START_ROOTS`
   - optional but recommended: `RELAY_HOST_ID`
   - optional: `STATE_FILE` if you want a custom persistence path; default uses an OS app-data location instead of the repo checkout
     - for deployed/stateless environments, point this at a mounted persistent path
     - if `RELAY_HOST_ID` is unset, Agent Tether persists a generated host id next to `STATE_FILE`

3. For multi-host mode:

   - On the hub machine, keep `RELAY_HUB_URL` empty and run `npm run bot`
   - On every non-hub machine, set:
     - `RELAY_HUB_URL=http://<hub-host>:8787`
     - `RELAY_HUB_TOKEN=<shared-secret>`
     - `RELAY_HOST_ID=<unique-machine-name>`
   - On the hub machine, also set:
     - `RELAY_HUB_TOKEN=<same-shared-secret>`
     - optionally `RELAY_HUB_BIND_HOST=0.0.0.0` if other machines must reach it over LAN/Tailscale
   - On worker machines, optionally set `RELAY_WORKER_CONCURRENCY` to allow multiple Telegram-run sessions in parallel on that host. Default: `4`

4. Find your Telegram user id:

   ```bash
   npm run discover-telegram
   ```

   Then DM `/chatid` to your bot and run `npm run discover-telegram` again. Add `from_user_id` to `AUTHORIZED_TELEGRAM_USER_IDS`.

5. Find your forum group id:

   - Add the bot to the forum supergroup
   - Send any message in the group or inside a topic
   - Run `npm run discover-telegram`
   - Set `chat_id` for the `supergroup` update as `TELEGRAM_FORUM_CHAT_ID`

6. Sync the bot commands and menu:

   ```bash
   npm run configure-telegram-bot
   ```

## Install global hooks

This repo ships a global hook installer:

```bash
npm run install-global-hooks
```

That updates:

- `~/.codex/config.toml` with `features.codex_hooks = true`
- `~/.codex/hooks.json` with handlers for `SessionStart`, `UserPromptSubmit`, and `Stop`
- `~/.claude/settings.json` with handlers for `SessionStart`, `UserPromptSubmit`, and `Stop`

## Run the relay

Start the bot loop:

```bash
npm run bot
```

Run the hub in the background and start it automatically at login on macOS:

```bash
npm run install-launch-agent -- --mode hub
```

Useful checks:

```bash
launchctl print gui/$(id -u)/dev.agent-tether.hub
tail -f ~/Library/Logs/agent-tether-hub.stdout.log
tail -f ~/Library/Logs/agent-tether-hub.stderr.log
```

Remove the background service:

```bash
npm run uninstall-launch-agent -- --mode hub
```

On every non-hub computer, run the worker:

```bash
npm run worker
```

Run the worker in the background and start it automatically at login on macOS:

```bash
npm run install-launch-agent -- --mode worker
```

Useful checks:

```bash
launchctl print gui/$(id -u)/dev.agent-tether.worker
tail -f ~/Library/Logs/agent-tether-worker.stdout.log
tail -f ~/Library/Logs/agent-tether-worker.stderr.log
```

Remove the background worker:

```bash
npm run uninstall-launch-agent -- --mode worker
```

Start your agent normally from the computer:

```bash
cd /absolute/path/to/repo
codex
```

Or:

```bash
cd /absolute/path/to/repo
claude
```

After the next hook event, that session appears in Telegram `/sessions` with its provider and host id.

## Telegram UX

- General topic is button-first: `New Session`, `Sessions`, `Archived`, `Status`, `Help`
- DM exposes the same management flow plus `Chat ID`
- `New Session` lets you choose provider, node, place, and folder, with `Back`, `Back to Nodes`, and `Back to Places` navigation
- Topic messages can be plain text, images, documents, or voice notes
- Accepted topic prompts get a best-effort 👀 reaction immediately
- Topic control messages include buttons for `Status`, `Queue`, `Stop`, `Latest`, `Show Steps` / `Hide Steps`, `Detach`, and `Archive`
- Session details include a `Show Steps` / `Hide Steps` toggle
- By default Telegram posts only the final reply for each turn; when steps are enabled for a session, Telegram sends intermediate step updates as new messages and still posts the final Markdown reply separately
- Session lists are sorted by newest `updatedAt` first and paginated 5 per page
- Slash commands still work, but normal use should not require typing them

## Agent defaults

- `AGENT_PROVIDER` defaults to `codex`
- `AGENT_PROVIDER` is the fallback default outside the Telegram new-session picker
- Locally indexed sessions keep whichever provider started them
- `CODEX_DEFAULT_ARGS` defaults to `--yolo`
- `CLAUDE_DEFAULT_ARGS` defaults to `--dangerously-skip-permissions`
- `WHISPER_BIN` defaults to `whisper` for Telegram voice-note transcription
- If you keep `--yolo`, Agent Tether will not also add explicit approval/sandbox config flags on top
- `RELAY_AUTO_ARCHIVE_AFTER_DAYS` defaults to `14`
- `RELAY_AUTO_PRUNE_AFTER_DAYS` defaults to `60`
- Set either one to `0` to disable that retention step

Optional fallback: start a headless non-interactive agent session from the computer:

```bash
npm run start-session -- --label "auth fix" --cwd /absolute/path/to/repo --prompt "Inspect the failing auth flow and propose a fix."
```

Start a session and bind a Telegram topic immediately:

```bash
npm run start-session -- --label "billing refactor" --cwd /absolute/path/to/repo --create-topic --prompt "Refactor the billing parser for clarity."
```

Optionally DM yourself when the session is created:

```bash
npm run start-session -- --label "docs cleanup" --notify-chat 123456789 --prompt "Summarize the current README gaps."
```

## Telegram usage

### General or DM control plane

- `/start` or `/help`
- `/chatid`
- `/sessions`
- `/archived`
- `/new`
- `/status`

`/sessions` shows indexed sessions with numbered rows:

- row number: bind or open
- `Details`
- `Archive`
- footer: `New Session`, `Archived`, `Refresh`, `Home`

Inside `Details`:

- `Show Steps` or `Hide Steps` toggles live intermediate-step updates for that session
- `Latest Reply`
- `Back`
- `Archive` on open sessions or `Restore` on archived sessions

`/archived` shows hidden sessions with:

- row number: restore
- `Details`
- `Latest`

### Topic work plane

Inside a bound forum topic:

- plain text continues the bound agent session
- images are downloaded and passed through to Codex as image inputs
- documents are downloaded into a temporary attachment directory and referenced in the prompt context
- voice notes are downloaded, transcribed with `whisper`, and attached with the transcript
- Telegram sends only the final reply by default
- `Show Steps` / `Hide Steps` is available directly on the bound-topic keyboard and in session details
- If `Show Steps` is enabled for the session, Telegram posts queued/progress updates as new messages while the turn runs, then posts the final reply separately
- `/queue` shows the running turn plus queued Telegram prompts
- `/status` includes the session details plus the current queue snapshot
- `/stop` aborts the current Telegram-run turn and clears queued Telegram prompts
- `/latest` resends the latest assistant reply
- `/reset` detaches the topic and returns the session to headless mode
- `/archive` hides the session from the main list and closes the topic

Back on the computer, resume the same session with:

```bash
cd /absolute/path/to/repo
codex resume <session_id>
```

Or for Claude Code:

```bash
cd /absolute/path/to/repo
claude --resume <session_id>
```

## Tests

```bash
npm test
```

## Smoke check

Run a quick operator smoke check against the configured hub, worker heartbeats, local Codex/Claude hook install, forum, and bot command sync:

```bash
npm run smoke
```

By default, smoke requires the configured local host id to have a fresh heartbeat. To require specific hosts by id or label:

```bash
RELAY_SMOKE_REQUIRED_HOSTS=Yogevs-MacBook-Pro-6,Yogevs-Mac-mini npm run smoke
```

## Queue cleanup

If Telegram prompts are stuck behind an abandoned local CLI run, run a dry-run cleanup first:

```bash
npm run cleanup-stale -- --host <host-id> --older-than-hours 24
```

Apply it after reviewing the output:

```bash
npm run cleanup-stale -- --host <host-id> --older-than-hours 24 --execute
```

Use `--all-hosts` only when you intentionally want to release stale local CLI busy flags across every host in the shared state file.

Compact old terminal job history with a dry run first:

```bash
npm run compact-state -- --terminal-job-retention-days 14 --max-terminal-jobs 5000
```

Apply it after reviewing the output:

```bash
npm run compact-state -- --terminal-job-retention-days 14 --max-terminal-jobs 5000 --execute
```

## Before Open Sourcing

- rotate any bot tokens used during development
- clear local state in `STATE_FILE` before the first commit

## License

MIT

## State model

- sessions are persisted in `STATE_FILE` (default: OS app-data dir; older `./data/state.json` installs are still read as a fallback and migrate on next write)
- when `RELAY_HOST_ID` is unset, Agent Tether persists a generated host id next to `STATE_FILE` and reuses it on restart
- each session stores:
  - label
  - cwd
  - agent session id
  - host id
  - latest assistant reply
  - whether intermediate-step updates are enabled
  - optional forum topic binding

## Safety defaults

- Only Telegram user ids in `AUTHORIZED_TELEGRAM_USER_IDS` can control the relay.
- Codex runs with `approval_policy=never` and `sandbox_mode=workspace-write` by default.
- Claude Code uses its configured `permission_mode` if you set `CLAUDE_PERMISSION_MODE`.
- Change those in `.env` if you want a different trust boundary.
- For multi-host mode, set a strong `RELAY_HUB_TOKEN` before exposing the hub API beyond localhost.

## Notes

- Global hooks only index sessions and keep their latest local prompt/reply metadata fresh.
- If a local CLI turn is still running, `/stop` can clear queued Telegram prompts but cannot kill the local terminal process.
- `codex exec resume`, `codex resume`, and `claude --resume` all target the same provider-specific session ids. The relay binds Telegram topics to those ids.
- The Telegram hub only polls Telegram once. Other computers run workers and hooks; they do not poll the bot token.
- The bot uses long polling. No webhook or public server required.
- Topic links are built from Telegram forum-topic link conventions using the group username when available, otherwise the private `t.me/c/...` form.
