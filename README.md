# Token-Coach for Claude Code

*Software by Novaprior*

Token-Coach shows you, right inside Claude Code, how full your context is, when compacting or a new chat pays off, what you save in tokens, money and time, and whether your subscription beats the API. It runs in the desktop app, the terminal and VS Code.

## Features

- **Overview:** what you saved this session and all time (tokens, money, more time before the 5-hour limit), the live check while you type, one clear recommendation with a **Compact now** button, and your usage limits with a forecast of when they run out.
- **Prompt:** a live check while you type (new chat or stay here?), a checklist for better prompts, **Improve** (Claude Haiku rewrites your draft), templates, and inline help while you type: vague words are underlined, and precise wordings to replace them appear in the hint bar above the prompt box, one click away.
- **Costs:** costs at API list prices per session, month and all time, and a comparison with your subscription.
- **Settings:** turn every hint on or off and set the thresholds.
- Commands: `/token-coach` opens the panel, `/token-settings` opens the settings.

All figures are estimates. Dollar amounts are at Anthropic's API list prices, also on a subscription.

## Installation

**From the zip:** unzip it to a folder that stays, then run `bash install.sh` on a Mac, or right-click `install.ps1` → *Run with PowerShell* on Windows. Details in `INSTALL.md`.

**From a GitHub repository**, at the prompt of a terminal session:

```
/plugin install token-coach --marketplace Novaprior/token-coach
```

Then `y` to add the marketplace, and pick a scope. From a shell:

```bash
claude plugin install token-coach --marketplace Novaprior/token-coach
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Novaprior/token-coach`, then **Add plugin**.

## Updating, turning off, uninstalling

- **Update:** run the install script again, or `claude plugin update token-coach@novaprior`, then restart the app.
- **Turn single hints off:** in the panel under **Settings**.
- **Turn it off:** `claude plugin disable token-coach@novaprior` (back on: `enable`), or in the app's plugin manager.
- **Uninstall:** `claude plugin uninstall token-coach@novaprior`, then `claude plugin marketplace remove novaprior`.

## Support

Token-Coach is provided as is, without support. Issues and messages are not monitored, and there is no promise of fixes or updates. You are welcome to fork it under the MIT License.

## License

Free and open source under the [MIT License](LICENSE.md). Every feature is available to everyone; no key, no account, no data leaves Claude Code.

## What it does inside Claude Code

Token-Coach is a mod: it hooks into Claude Code's own events. Every hook below passes the event on unchanged unless stated otherwise.

| Hook | What Token-Coach does with it |
|---|---|
| `session.start`, `session.end` | Loads your settings and statistics, registers its two commands, opens the panel; on `/clear` it resets the session figures and, after **New chat**, puts your draft back in the prompt box. |
| `session.measure` | Reads the context fill, usage limits and session cost to show them. |
| `turn.step` | Reads each model request's token usage after it completes, to show the context live and price it at list prices. It does not change requests. |
| `turn.complete` | Notes when the last answer ended and reads the recent messages for the live check. |
| `session.compact` | Reads the size before and after a compaction to show the new context and what compacting saved. It does not change compactions. |
| `prompt.edit` | Reads your draft as you type for the live check and checklist; underlines vague words in the prompt box. It never changes what you type. |
| `prompt.submit` | Clears the live check when you send. It does not change your prompt. |
| `command.run` (`/token-coach`, `/token-settings`) | Answers its own two commands by opening the panel. |
| `ui.render` | Draws the panel and the hint bar above the prompt box. |

**Commands it runs:** only when you click **Compact now** (in the panel or the hint bar) does Token-Coach run `/compact` for you, with instructions to keep the current task, decisions, open points and file paths. **New chat** puts `/clear` in your prompt box; you send it yourself.

**Model use:** **Improve** sends your current draft to Claude Haiku through your own Claude Code session (`$.model.complete`), only when you click it, and shows the rewrite for you to accept or discard. Token-Coach reads no credentials, keys or files of its own; it uses Claude Code's session as it is.

## Privacy

Token-Coach runs inside Claude Code and sends nothing to any other service. It reads the session's usage figures and the prompt you type to give its advice. **Improve** sends your draft to Claude Haiku through your own Claude Code session, only when you click it. Settings and statistics are stored locally by Claude Code.
