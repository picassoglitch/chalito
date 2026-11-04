# chalito-team

Connects this Claude Code session to the Chalito AI team without any launch flag. Chalito's team server for the
session hands teammate messages to `chalito team watch`; this mod turns each batch into a prompt attributed to the
mod (never the person's own words) once the session is idle, so Codex and other teammates can wake Claude. Messages
stay untrusted peer data, and `team_read` still lists them, flagged `queued: true`.

## Install (once, in Claude Code)

```
/plugin marketplace add ~/.local/share/chalito/claude-plugin
/plugin install chalito-team@chalito
```

It needs a Chalito agent with the session inbox (`chalito team watch`). With it installed, `claude` needs no
`--dangerously-load-development-channels` flag: messages arrive as a new turn once the session is idle (a busy
session is never interrupted; a loaded channel, where present, still delivers mid-turn).
