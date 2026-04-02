# Agent Tether

Run coding agents on your machine as usual. Global Codex hooks index sessions locally. Telegram lets you bind one of those sessions to a forum topic and continue it remotely.

## Model

- Local Codex sessions are indexed by global hooks.
- Telegram DM is the control plane.
- A Telegram forum topic is the work surface for one Codex session.
- Sessions stay headless until you bind one from `/sessions`.
- Sessions are owned by one `host_id`, so one bot can route work to multiple computers.
- Telegram can also create a fresh session: choose node, choose place, browse directories, open topic, send first prompt.

## Requirements

- Node 20+
- `codex` CLI installed and logged in
- Telegram bot token from BotFather
- A Telegram supergroup with Topics enabled
- The bot added to that supergroup as admin with topic management rights
- Global Codex hooks enabled in `~/.codex`

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
   - `RELAY_HOST_ID`

3. For multi-host mode:

   - On the hub machine, keep `RELAY_HUB_URL` empty and run `npm run bot`
   - On every non-hub machine, set:
     - `RELAY_HUB_URL=http://<hub-host>:8787`
     - `RELAY_HUB_TOKEN=<shared-secret>`
     - `RELAY_HOST_ID=<unique-machine-name>`
   - On the hub machine, also set:
     - `RELAY_HUB_TOKEN=<same-shared-secret>`
     - optionally `RELAY_HUB_BIND_HOST=0.0.0.0` if other machines must reach it over LAN/Tailscale

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

Start Codex normally from the computer:

```bash
cd /absolute/path/to/repo
codex
```

After the next hook event, that session appears in Telegram `/sessions` with its host id.

## Telegram UX

- DM is button-first: `Sessions`, `Status`, `Help`
- DM also supports `New Session`: choose node, choose place, browse subdirectories, then open a fresh topic
- Topic messages are still plain text prompts
- Topic control messages include buttons for `Status`, `Latest`, and `Detach`
- Slash commands still work, but the normal flow should not require typing them

## Codex defaults

- `CODEX_DEFAULT_ARGS` defaults to `--yolo`
- If you keep `--yolo`, Agent Tether will not also add explicit approval/sandbox config flags on top

Optional fallback: start a headless non-interactive Codex session from the computer:

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

### DM control plane

- `/start` or `/help`
- `/chatid`
- `/sessions`
- `/status`

`/sessions` shows indexed sessions with buttons:

- `Bind ...` for headless sessions
- `Open ...` for already bound sessions
- `Details`
- `Latest`

### Topic work plane

Inside a bound forum topic:

- plain text continues the Codex session
- partial Codex progress streams into the topic while the turn runs
- `/status` shows session details
- `/latest` resends the latest assistant reply
- `/reset` detaches the topic and returns the session to headless mode

Back on the computer, resume the same session with:

```bash
cd /absolute/path/to/repo
codex resume <session_id>
```

## Tests

```bash
npm test
```

## Before Open Sourcing

- rotate any bot tokens used during development
- clear local state in `data/` before the first commit

## License

MIT

## State model

- sessions are persisted in `STATE_FILE`
- each session stores:
  - label
  - cwd
  - Codex session id
  - host id
  - latest assistant reply
  - optional forum topic binding

## Safety defaults

- Only Telegram user ids in `AUTHORIZED_TELEGRAM_USER_IDS` can control the relay.
- Codex runs with `approval_policy=never` and `sandbox_mode=workspace-write` by default.
- Change those in `.env` if you want a different trust boundary.
- For multi-host mode, set a strong `RELAY_HUB_TOKEN` before exposing the hub API beyond localhost.

## Notes

- Global hooks only index sessions and keep their latest local prompt/reply metadata fresh.
- `codex exec resume` and `codex resume` both target the same Codex session id. The relay binds Telegram topics to those ids.
- The Telegram hub only polls Telegram once. Other computers run workers and hooks; they do not poll the bot token.
- The bot uses long polling. No webhook or public server required.
- Topic links are built from Telegram forum-topic link conventions using the group username when available, otherwise the private `t.me/c/...` form.
