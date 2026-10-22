# Installing Token-Coach

*Software by Novaprior*

Token-Coach shows you, right inside Claude Code, how full your context is, when compacting pays off, what you save in tokens, money and time, and whether your subscription beats the API. While you type, it checks your prompt and suggests more precise wordings. Free and open source (MIT).

Runs on **macOS and Windows**, in the Claude desktop app, the terminal and VS Code.

## Requirements

The Claude desktop app (or Claude Code in the terminal) is installed and you are signed in.

## Installing on a Mac

1. **Unzip** to a folder that stays, e.g. `~/Tools/token-coach`.
2. **Open Terminal** (Applications → Utilities → Terminal) and run:
   ```bash
   bash ~/Tools/token-coach/install.sh
   ```
3. **Restart the app** and open a new session. The Token-Coach panel appears next to the chat; if not, type `/token-coach`.

If the script cannot find Claude Code, open a Claude Code session in the desktop app in `~/Tools/token-coach` and write: “Run install.sh”.

## Installing on Windows

1. **Unzip** to a folder that stays, e.g. `C:\Tools\token-coach`.
2. **Right-click `install.ps1`** → **Run with PowerShell**. Or in PowerShell:
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Tools\token-coach\install.ps1
   ```
3. **Restart the app** and open a new session.

## First steps

- **Overview:** at the top what you saved (tokens, money, time), below it the current recommendation, and at the bottom your usage limits.
- **Costs:** costs per session, month and all time at API list prices. Enter your subscription price under **Settings → Your subscription per month** to see whether the subscription or the API is cheaper.
- **Settings:** turn each recommendation on or off and adjust the thresholds.

## Updating

Copy the new zip's contents over the old folder and run the install script again. Then restart the app.

## Turning off or uninstalling

- **Single hints:** in the panel under **Settings**.
- **Turn it off for now:** `claude plugin disable token-coach@novaprior` (back on: `claude plugin enable token-coach@novaprior`), then open a new session. Once installed, it also appears in the desktop app's plugin manager (**Plugins** → **Mine**).
- **Remove it:** `claude plugin uninstall token-coach@novaprior`, then `claude plugin marketplace remove novaprior`. You can delete the folder afterwards.

## Questions

Novaprior · [novaprior.com](https://novaprior.com)
