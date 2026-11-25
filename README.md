# xVSGravityTools

An all-in-one Visual Studio Code extension that brings project, Git, file, script, browser-debugging, and network utilities into one Activity Bar sidebar.

## Features

All tools are active whenever the extension is active. Configure individual tool behavior in VS Code Settings.

### Git Repo Manager

- Scan one or more selected search directories recursively for Git repositories, with configurable scan depth and excluded directory patterns.
- Browse repositories in the **Git Repositories** sidebar, grouped by parent folder, with active branch and sync/remote visibility indicators where available.
- Open a repository in the current or a new VS Code window, or find and open repositories through a searchable QuickPick (`Ctrl+Alt+R`).
- Pin favorite repositories, hide repositories from the active list, and restore hidden repositories.
- Create project folders under a selected search directory, refresh the repository list, reveal a repository in the system file browser, open its integrated terminal, and copy its path.
- Configure search directories, scan depth, grouping, branch display, automatic expansion, favorite and hidden repositories, and exclusions in Settings.

### Git Management

- Initialize a Git repository in a selected folder, stage all non-ignored files, and create an initial commit with a message you provide.
- Search official GitHub `.gitignore` templates and save a chosen template to a destination you select. If GitHub is unavailable, a small built-in set of templates is available. Existing files require confirmation before replacement; templates are saved as files and are not merged into an existing `.gitignore`.
- Smart Git ignore/track toggle: Automatically detects whether a right-clicked file or folder is already ignored in `.gitignore`. Shows **Add to .gitignore & Untrack** for active/tracked files, and dynamically flips to **Track and Remove from .gitignore** for ignored files, with preloaded caching on project open and file changes for instantaneous context menu display.
- Clear Git's cached tracking of ignored/untracked files in a repository.
- Audit global Git configuration and choose recommended settings to apply.
- Generate a starter `LICENSE` (MIT, Apache-2.0, GPL-3.0, BSD-3-Clause, ISC, or Unlicense) or `README.md` for a project.
- Open the Repository Template Generator, which provides shortcuts for repository setup, `.gitignore` download, license creation, and README creation.

### Extension Update Manager

- Automatically disables VS Code's built-in extension auto-updates while management is enabled.
- Checks the VS Code version at startup and runs one update pass for installed extensions only when the VS Code version has changed.
- Enable or disable this behavior with **xVSGravityTools: Manage Extension Updates** in Settings (enabled by default).
- When disabled, restores the previous global `extensions.autoUpdate` value.

### Smart Commit Generator

- Analyze staged Git changes and generate commit message suggestions locally, without an AI service or API key.
- Generate Conventional Commit, emoji, simple, and detailed styles; optionally include an inferred scope and a body listing changed files.
- Choose whether to fall back to unstaged changes when nothing is staged, or automatically stage changes when none are staged.
- Configure the default format and emoji style. Use the Source Control action or `Ctrl+Alt+G`; the command palette also offers **Generate Commit Message (Choose Style...)**.
- Manage inference from the Command Center's **Settings** tab: configure your OpenAI-compatible inference API URL, load available models from `/v1/models`, select any exposed model, and set or clear an optional API key.
- API keys are stored in VS Code / IDE SecretStorage and are not written to settings or source files.
- If no inference URL or model is configured, Smart Commit automatically falls back to its built-in local heuristic generator.

### xScript Runner

- Run a selected file from the Explorer context menu or the active editor in the integrated terminal.
- Provides direct handling for `.bat`/`.cmd`, `.ps1`, `.py`, `.js`, and `.sh` files; other file types are sent to the terminal as commands.
- Launch `.exe` and `.msi` files as external programs.

### HTML Chrome Debugger

- Serve a local workspace or file directory over HTTP and open the selected file in Google Chrome.
- Watch for file saves and reload connected browser pages automatically using server-sent events.
- Start the local server on port 8080, or the next available port, and show its status in the status bar; stop the server from the command or status bar.
- Automatically append a live-reload client to served HTML pages and launch Chrome with remote debugging enabled.

### File & Explorer Tools

Available from Explorer/editor context menus, depending on the selected item:

- Copy a file's contents to the clipboard.
- Open a local file as text in Chrome.
- Copy a file or folder path.
- Calculate MD5, SHA-1, and SHA-256 hashes; copy supported results to the clipboard.
- Show file metadata, including name, type, path, size, and timestamps.
- Alphabetize lines with selectable sort options, and remove duplicate lines with selectable handling options.
- Add a folder to the Windows user or system `PATH` (system changes may request administrator approval).

### System & Network Utilities

- Check internet connectivity using network probes.
- Flush the system DNS resolver cache.
- Inspect local network interfaces and addresses, view the external IP address, copy available values, and open detailed system diagnostics in an output channel.

## Commands and menus

Use the Command Palette (`Ctrl+Shift+P`) to find commands by names such as **Open Repository**, **Download .gitignore Template**, **Generate Commit Message**, and **Debug in Chrome (Live Server)**. Git repository and file actions are also available in their sidebar or Explorer/editor context menus. The extension contributes developer and project menus for commonly used actions.

## Settings

Search VS Code Settings for `gitRepoManager`, `gitManagement`, `htmlChromeDebugger`, or `smartCommit`. Git Repo Manager scan/display preferences and Smart Commit formatting and staging behavior can be configured individually.

## Install from source

Requirements: Node.js/npm, Git for Git features, and Visual Studio Code 1.80 or later. Chrome is needed for Chrome debugging and file preview.

```sh
npm install
npm run compile
```

To package an installable VSIX, use the VS Code Extension packaging tool:

```sh
npx @vscode/vsce package --no-dependencies --allow-missing-repository
```

Then install the generated `.vsix` using **Extensions: Install from VSIX...** in VS Code, or:

```sh
code --install-extension x-vsgravity-tools-1.0.0.vsix
```

For development, open this folder in VS Code, install dependencies, and press `F5` to launch an Extension Development Host.
