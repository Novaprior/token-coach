# Token-Coach for Claude Code

*Software by Novaprior*

Token-Coach shows you, right inside Claude Code, how full your context is, when compacting or a new chat pays off, what you save in tokens, money and time, and whether your subscription beats the API. It runs in the desktop app, the terminal and VS Code.

## Features

- **Overview:** what you saved this session and all time (tokens, money, more time before the 5-hour limit), one clear recommendation with a **Compact now** button, and your usage limits with a forecast of when they run out.
- **Prompt:** a live check while you type (new chat or stay here?), a checklist for better prompts, **Improve** (Claude Haiku rewrites your draft), templates, and inline suggestions while you type: vague words are underlined, and precise wordings or file paths from the chat appear in the typeahead, taken with Tab.
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

## License

Free and open source under the [MIT License](LICENSE.md). Every feature is available to everyone; no key, no account, no data leaves Claude Code.

## Privacy

Token-Coach runs inside Claude Code and sends nothing to any other service. It reads the session's usage figures and the prompt you type to give its advice. **Improve** sends your draft to Claude Haiku through your own Claude Code session, only when you click it. Settings and statistics are stored locally by Claude Code.
