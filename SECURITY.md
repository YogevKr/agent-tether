# Security

If you find a security issue, do not open a public issue with exploit details.

Report it privately to the maintainer first and include:

- affected version or commit
- reproduction steps
- impact
- suggested mitigation if you have one

Sensitive areas in this project:

- Telegram bot tokens
- `RELAY_HUB_TOKEN`
- host-to-hub networking
- Codex hook execution on developer machines

Before publishing logs or screenshots, redact secrets, user ids, and internal hostnames.
