# TerminalS

A Windows terminal (Electron + xterm.js + ConPTY) with a searchable command history panel, inline AI command suggestions, and a manager for environment variables and per-shell startup scripts.

## Run

```powershell
npm install
npm start
```

`npm run check` syntax-checks the sources and runs the unit tests (redaction, suggestion parsing, safety guard, shell translation).

`npm run icons` regenerates `assets/icon.ico` (16–256 px) and `assets/icon.png` from `assets/icon.svg`, the mark taken from `terminals-logo.svg`.

## Features

- **Tabs** for PowerShell 7, Windows PowerShell, Command Prompt, Git Bash and WSL (whichever are installed).
- **History panel** (`Ctrl+Shift+H`): every command with its folder, time and exit code. Search it, filter to the current folder, click to insert, double-click (or `Ctrl+Enter` in the search box) to run. Your PSReadLine history (and Git Bash `~/.bash_history`, if present) is imported on first launch; cmd.exe keeps no history file, so cmd history starts with what you run in TerminalS. Commands recorded in one shell are suggested in others only when they work everywhere (`npm`, `git`, `docker`, `python`, `cd`, … without shell-specific syntax such as `$env:` or `%VAR%`). "This shell only" filters the panel; entries from another shell carry a small PS / cmd / bash label.
- **Pinned commands**: click ☆ on any history entry to pin it; the **Pinned** tab lists them (reorder with ↑/↓, unpin with ★). Pins survive clearing history and take priority in suggestions.
- **Ghost text** (local only): grey inline text from your pins and history appears instantly. While it is shown, `↑`/`↓` step through every matching command (pins first, then this folder, then elsewhere; the status bar shows e.g. 2/13), `Tab` or `→` accepts, `Esc` dismisses. With nothing typed or no suggestion, `↑`/`↓` go through the shell's own history as usual. Both can be turned off in Settings.
- **AI suggestions on demand**: press **space twice quickly** (default 300 ms window) or **Ctrl+Space** to open a picker at the cursor with pinned/history matches first and 5 AI suggestions (3–10, configurable), each with a short note. `↑↓` select, `Enter`/`Tab` insert, `1`–`9` quick pick, `Ctrl+Enter` insert and run, `Esc` close — or click. Keep typing and trigger again to refine. Start the line with `#` to describe what you want in plain words. Rows marked ⚠ destructive are never run straight from the picker, and "replaces line" rows swap out what you typed. Nothing is sent to the AI while you type.
- **Environment & startup** (`Ctrl+Shift+E`):
  - Environment variables: set / prepend / append (e.g. PATH), for all shells or one. Applied to new tabs only, inside the terminal's process; nothing is written to the registry.
  - Secret variables are encrypted with Windows DPAPI (Electron `safeStorage`) and never shown again. Values whose name or content look like a credential are stored as secrets automatically.
  - Startup scripts per shell family (PowerShell, cmd, Git Bash), run in every new tab after your normal profile. Scripts that appear to contain credentials are rejected — use a secret variable instead.
- Themes (including the **TerminalS** brand theme), font size, default shell, AI provider, trigger (double-space window, hotkey: Ctrl+Space / Ctrl+Shift+Space / Alt+/ / none), suggestion count and ghost text in **Settings** (`Ctrl+,`).

## AI tools

Each can be switched on or off, and configured, in **Settings → Tools** / **Usage**.

- **Fix last command** — when a command fails, a **✦ Fix** chip appears on the prompt; click it or press **Alt+F** for AI fixes that replace the line. The failed command's last lines of output (40 by default, redacted first) are included; you can turn that off or change the count. Also catches commands written for another shell (e.g. `grep` in PowerShell).
- **Safety guard** — pressing Enter on a risky command (recursive deletes, `git reset --hard`, force push, disk formatting, `DROP TABLE`, `kubectl delete`, `terraform destroy`, `curl … | sh`, …) opens a confirmation: **Y** runs it, **Esc** leaves it on the line. Also warns about `git push`/`reset`/`rebase` on protected branches (`main, master` by default, globs allowed; the branch is read from `.git/HEAD`). Checked locally — nothing is sent. Each category can be switched off. Running from the history panel or the picker goes through the same check.
- **Translate between shells** — paste a command written for another shell (e.g. bash `export X=1` into PowerShell) and TerminalS asks whether to translate it; **Enter** shows translations, **Esc** keeps the paste. **Alt+T** translates whatever is on the line. Common one-liners are translated instantly by built-in rules (no AI); the rest go to the AI with the target shell's version (PowerShell 5.1 vs 7 matters). Detection sensitivity is configurable.
- **Usage meter** — counts AI requests and tokens per day (counts only, never content) with an estimated cost for Claude models. Shown in the status bar and in Settings → Usage (today / 7 / 30 days, by feature). Optional daily request and token caps stop AI requests when reached.
- **AI-excluded folders** — no AI requests of any kind from these folders or their subfolders (for example customer data or support reproductions).

## Shortcuts

| Keys | Action |
|---|---|
| `Ctrl+Shift+T` / `Ctrl+Shift+1..9` | New tab (same shell / specific shell) |
| `Ctrl+Shift+W` | Close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+Shift+H` | Toggle history panel |
| `Ctrl+Shift+E` | Environment & startup manager |
| `Ctrl+,` | Settings |
| Space Space / `Ctrl+Space` | AI suggestion picker (configurable) |
| `Alt+F` | Fix last failed command (configurable) |
| `Alt+T` | Translate the line to this tab's shell (configurable) |
| `Ctrl+C` (with selection) / `Ctrl+Shift+C` | Copy |
| `Ctrl+V` / right-click | Paste (right-click copies instead when text is selected; configurable) |
| `F12` | DevTools |

## AI suggestions

Pick a provider in Settings:

| Provider | SDK | Configure |
|---|---|---|
| Claude API (Anthropic) | `@anthropic-ai/sdk` | Model (`claude-opus-5` default, low effort, server-side refusal fallbacks; `claude-sonnet-5`, `claude-haiku-4-5` for lowest latency). Key: `ANTHROPIC_API_KEY` or Settings. |
| Claude on Azure AI Foundry | `@anthropic-ai/foundry-sdk` | Resource name or `https://…services.ai.azure.com/anthropic/` URL, model/deployment name. Defaults to `ANTHROPIC_FOUNDRY_BASE_URL` + `ANTHROPIC_FOUNDRY_API_KEY`. |
| Azure OpenAI (Foundry) | `openai` (`AzureOpenAI`) | Endpoint, deployment, API version (default `2024-10-21`). Defaults to `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY`. |

Azure providers can sign in with an **API key** or **Entra ID** (`@azure/identity` `DefaultAzureCredential`: `az login`, Azure PowerShell, managed identity). Entra ID issues short-lived tokens instead of long-lived static keys.

Safety rails:
- Endpoints must be `https://` on an Azure AI domain (`*.openai.azure.com`, `*.services.ai.azure.com`, `*.cognitiveservices.azure.com`).
- A key taken from an environment variable is only ever sent to the endpoint from the matching environment variable. If you type a different endpoint, save a key for it in Settings.
- Keys pasted in Settings are stored encrypted with DPAPI. For session-only env vars use `$env:NAME = '...'`, not `setx`.
- **Test connection** in Settings sends a fixed synthetic prompt (`git st`) with no context.

What is sent: the typed prefix, the shell name and — if "Send context" is on — the current folder, its file names, and your last 20 commands. Everything passes through `src/main/redact.js` first; if the typed input itself looks like it contains a credential, no request is made. Terminal state is sent as JSON data, separate from the instructions, and the reply is validated (single line, no control characters, must extend what you typed).

## How it works

Each shell is started with a small integration script (`src/main/shell-integration/`) that wraps the prompt to emit OSC 633 markers — the same protocol VS Code uses — for prompt start, input start, exit code and current directory. The terminal reads the command line straight from the screen buffer between the input-start marker and the cursor, so suggestions stay correct after tab completion, history recall and in-line edits. WSL has no integration yet and falls back to a heuristic.

The PowerShell integration is dot-sourced via `-Command`, so a machine-wide execution policy that blocks scripts will disable integration (the shell still works, just without folder tracking, exit codes and reliable suggestions).

## Data

Stored under `%APPDATA%\TerminalS\`:

- `settings.json`, `profiles.json` (non-secret variables, scripts), `history.json`, `pins.json`, `usage.json` (daily counters only)
- `secrets.json` — DPAPI-encrypted secret variables and API keys
- `startup-scripts\` — the generated startup script files

Commands that look like they contain credentials are never saved to history.

## Build an .exe

```powershell
npm run dist       # dist\TerminalS Setup <version>.exe (installer) + dist\TerminalS-<version>-portable.exe
npm run dist:dir   # dist\win-unpacked\TerminalS.exe only (no installer), fastest
```

Built with electron-builder (config under `"build"` in `package.json`). node-pty's prebuilt Windows binaries are used as-is (`npmRebuild: false`, no Visual Studio needed). The shell-integration scripts and node-pty are unpacked from the asar archive because the shells and ConPTY must read them from disk.

**Code signing.** The output is unsigned. On machines with application control (AppLocker/WDAC/endpoint protection), unsigned executables are blocked from running, and the installer build itself fails with `spawn EPERM` because electron-builder runs the generated uninstaller while building. Sign with your organisation's code-signing certificate, e.g. by providing it to electron-builder through the `CSC_LINK` / `CSC_KEY_PASSWORD` environment variables from your secret store (never commit the certificate or password), or via Azure Trusted Signing (`build.win.azureSignOptions`). Otherwise ask IT to allowlist the build.
