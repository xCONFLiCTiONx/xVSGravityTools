import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { execFile } from 'child_process';

export interface GitignoreTemplateItem {
    name: string;
    category: string;
    rawUrl?: string;
    isOffline?: boolean;
}

export class TemplateFetcher {
    private static readonly USER_AGENT = 'VSCode-GitManagement-Extension';
    private static cachedTemplates: GitignoreTemplateItem[] | null = null;

    public static async getTemplateList(): Promise<GitignoreTemplateItem[]> {
        if (this.cachedTemplates) return this.cachedTemplates;
        try {
            const templates: GitignoreTemplateItem[] = [];
            const officialNames = await this.fetchJson<string[]>('https://api.github.com/gitignore/templates');
            for (const name of officialNames) {
                templates.push({
                    name,
                    category: 'Language/Framework',
                    rawUrl: `https://raw.githubusercontent.com/github/gitignore/main/${encodeURIComponent(name)}.gitignore`
                });
            }
            templates.sort((a, b) => a.name.localeCompare(b.name));
            if (templates.length > 0) {
                this.cachedTemplates = templates;
                return templates;
            }
        } catch {
            // fallback
        }
        return this.getOfflineTemplates();
    }

    public static async downloadTemplateContent(template: GitignoreTemplateItem): Promise<string> {
        if (template.isOffline || !template.rawUrl) {
            return this.getOfflineContent(template.name);
        }
        try {
            if (template.rawUrl) {
                const raw = await this.fetchText(template.rawUrl);
                if (raw && raw.trim().length > 0) return raw;
            }
        } catch {
            // fallback
        }
        return this.getOfflineContent(template.name);
    }

    private static fetchJson<T>(urlStr: string): Promise<T> {
        return new Promise((resolve, reject) => {
            https.get(urlStr, { headers: { 'User-Agent': this.USER_AGENT, 'Accept': 'application/vnd.github.v3+json' }, timeout: 8000 }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            }).on('error', reject);
        });
    }

    private static fetchText(urlStr: string): Promise<string> {
        return new Promise((resolve, reject) => {
            https.get(urlStr, { headers: { 'User-Agent': this.USER_AGENT }, timeout: 8000 }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });
    }

    public static getOfflineTemplates(): GitignoreTemplateItem[] {
        return [
            { name: 'Node', category: 'Language/Framework', isOffline: true },
            { name: 'Python', category: 'Language/Framework', isOffline: true },
            { name: 'Java', category: 'Language/Framework', isOffline: true },
            { name: 'Go', category: 'Language/Framework', isOffline: true },
            { name: 'Rust', category: 'Language/Framework', isOffline: true },
            { name: 'Android', category: 'Language/Framework', isOffline: true },
            { name: 'Flutter', category: 'Language/Framework', isOffline: true },
            { name: 'VisualStudioCode', category: 'Global/IDE/OS', isOffline: true },
            { name: 'JetBrains', category: 'Global/IDE/OS', isOffline: true },
            { name: 'macOS', category: 'Global/IDE/OS', isOffline: true },
            { name: 'Windows', category: 'Global/IDE/OS', isOffline: true }
        ];
    }

    private static getOfflineContent(name: string): string {
        const key = name.toLowerCase();
        if (key.includes('node')) return 'node_modules/\ndist/\nbuild/\n.env\n';
        if (key.includes('python')) return '__pycache__/\n*.py[cod]\nvenv/\n.env\n';
        if (key.includes('vscode')) return '.vscode/*\n!.vscode/settings.json\n*.vsix\n';
        if (key.includes('macos')) return '.DS_Store\n';
        if (key.includes('windows')) return 'Thumbs.db\nDesktop.ini\n';
        return `# ${name}\n*.log\nbuild/\ndist/\n`;
    }
}

function runGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || stdout || err.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

export function activateGitManagement(context: vscode.ExtensionContext) {
    const initRepo = vscode.commands.registerCommand('git-management.initializeRepository', async (uri?: vscode.Uri) => {
        let targetDir = await resolveWorkspaceFolder(uri);
        if (!targetDir) {
            targetDir = (await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select folder to initialize as a Git repository' }))?.uri.fsPath;
        }
        if (!targetDir) return;

        const gitDir = path.join(targetDir, '.git');
        let existingGitRoot: string | undefined;
        try {
            existingGitRoot = (await runGit(targetDir, ['rev-parse', '--show-toplevel'])).trim();
        } catch { /* This folder is not in a repository. */ }

        const hasLocalGit = fs.existsSync(gitDir);

        if (hasLocalGit || existingGitRoot) {
            const warnMsg = hasLocalGit
                ? `"${path.basename(targetDir)}" already has Git management (.git). Do you want to remove the existing .git history and initialize a fresh repository, stage all files, and create an initial commit?`
                : `"${path.basename(targetDir)}" is currently inside a parent Git repository ("${existingGitRoot}"). Do you want to initialize a fresh standalone .git repository here, stage all files, and create an initial commit?`;
            const confirmed = await vscode.window.showWarningMessage(
                warnMsg,
                { modal: true },
                'Reinitialize, Stage & Commit'
            );
            if (confirmed !== 'Reinitialize, Stage & Commit') return;
        } else {
            const confirmed = await vscode.window.showWarningMessage(
                `Initialize Git in "${path.basename(targetDir)}", stage all non-ignored files, and create an initial commit?`,
                { modal: true }, 'Initialize, Stage & Commit'
            );
            if (confirmed !== 'Initialize, Stage & Commit') return;
        }

        const message = await vscode.window.showInputBox({
            prompt: 'Initial commit message', value: 'Initial commit',
            validateInput: value => value.trim() ? undefined : 'Commit message cannot be empty.'
        });
        if (!message) return;

        try {
            if (fs.existsSync(gitDir)) {
                await fs.promises.rm(gitDir, { recursive: true, force: true });
            }
            await runGit(targetDir, ['init']);
            await runGit(targetDir, ['add', '-A']);
            try {
                await runGit(targetDir, ['diff', '--cached', '--quiet']);
                vscode.window.showErrorMessage('Repository initialized, but there are no files to commit.');
                return;
            } catch { /* Exit code 1 means staged changes are present. */ }
            await runGit(targetDir, ['commit', '-m', message]);
            vscode.commands.executeCommand('gitRepoManager.refresh').then(undefined, () => {});
            vscode.window.showInformationMessage(`Initialized repository and created the initial commit in "${path.basename(targetDir)}".`);
        } catch (error) {
            vscode.window.showErrorMessage(`Git initialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    const downloadGitignore = async (uri?: vscode.Uri) => {
        const dir = await resolveWorkspaceFolder(uri);
        if (!dir) {
            vscode.window.showErrorMessage('No workspace folder open or directory selected.');
            return;
        }
        const templates = await TemplateFetcher.getTemplateList();
        const picked = await vscode.window.showQuickPick(
            templates.map(t => ({ label: t.name, description: t.category, template: t })),
            { placeHolder: 'Search GitHub .gitignore templates by language, framework, or tool' }
        );
        if (!picked) return;
        let content: string;
        try {
            content = await TemplateFetcher.downloadTemplateContent(picked.template);
        } catch (error) {
            vscode.window.showErrorMessage(`Could not download the ${picked.template.name} .gitignore template: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const destination = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(dir, '.gitignore')),
            saveLabel: 'Download .gitignore',
            filters: { 'Git ignore files': ['gitignore'], 'All files': ['*'] }
        });
        if (!destination) return;
        if (fs.existsSync(destination.fsPath)) {
            const overwrite = await vscode.window.showWarningMessage(
                `${path.basename(destination.fsPath)} already exists. Replace it with the ${picked.template.name} template?`,
                { modal: true }, 'Replace'
            );
            if (overwrite !== 'Replace') return;
        }
        try {
            fs.writeFileSync(destination.fsPath, content, 'utf8');
            const doc = await vscode.workspace.openTextDocument(destination);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Downloaded the ${picked.template.name} .gitignore template.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Could not save the .gitignore template: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const gen = vscode.commands.registerCommand('git-management.generateGitignore', downloadGitignore);
    // Keep the old command ID working for users who have it in keybindings or custom menus.
    const compare = vscode.commands.registerCommand('git-management.downloadAndCompareGitignore', downloadGitignore);
    const cleanCache = vscode.commands.registerCommand('git-management.cleanUntrackedCache', async (uri?: vscode.Uri) => {
        let targetDir: string | undefined = uri?.fsPath;
        if (!targetDir && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            if (vscode.workspace.workspaceFolders.length === 1) {
                targetDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
            } else {
                const pick = await vscode.window.showWorkspaceFolderPick({
                    placeHolder: 'Select workspace folder to clean untracked Git ignore cache'
                });
                if (!pick) return;
                targetDir = pick.uri.fsPath;
            }
        }

        if (!targetDir) {
            vscode.window.showErrorMessage('No workspace folder open or directory selected.');
            return;
        }

        if (fs.existsSync(targetDir) && !fs.statSync(targetDir).isDirectory()) {
            targetDir = path.dirname(targetDir);
        }

        let repoRoot: string;
        try {
            const rootOut = await runGit(targetDir, ['rev-parse', '--show-toplevel']);
            repoRoot = rootOut.trim();
        } catch {
            vscode.window.showErrorMessage(`"${targetDir}" is not part of a Git repository.`);
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Clean Untracked Git Ignore Cache for "${path.basename(repoRoot)}"?\n\nThis will refresh Git's staging index (git rm -r --cached . && git add .) to stop tracking files listed in .gitignore. Your local files on disk will NOT be deleted.`,
            { modal: true },
            'Clean Cache'
        );

        if (confirm !== 'Clean Cache') {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Cleaning Git ignore cache for ${path.basename(repoRoot)}...`,
                cancellable: false
            },
            async () => {
                try {
                    await runGit(repoRoot, ['rm', '-r', '--cached', '.']);
                    await runGit(repoRoot, ['add', '.']);
                    vscode.window.showInformationMessage(
                        `Successfully refreshed Git ignore cache for "${path.basename(repoRoot)}". Files matching .gitignore rules are now untracked.`
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage(
                        `Failed to clean Git ignore cache: ${err?.message || err}`
                    );
                }
            }
        );
    });

    const addToGitignoreCmd = vscode.commands.registerCommand('git-management.addToGitignoreAndUntrack', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        await addToGitignoreAndUntrack(uri, uris);
    });

    const removeFromGitignoreCmd = vscode.commands.registerCommand('git-management.removeFromGitignoreAndTrack', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        await removeFromGitignoreAndTrack(uri, uris);
    });

    // Preload ignored paths so the context menu can evaluate dynamically without delay
    preloadIgnoredPaths().catch(() => {});

    // Preload when workspace folders change
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => triggerDebouncedPreload()));

    // Preload when any files are created, changed, or deleted in the workspace
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(watcher);
    watcher.onDidChange(() => triggerDebouncedPreload());
    watcher.onDidCreate(() => triggerDebouncedPreload());
    watcher.onDidDelete(() => triggerDebouncedPreload());

    // Preload immediately if .gitignore is edited/saved
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
        if (path.basename(doc.uri.fsPath).toLowerCase() === '.gitignore') {
            preloadIgnoredPaths().catch(() => {});
        } else {
            triggerDebouncedPreload();
        }
    }));

    const addLicenseCmd = vscode.commands.registerCommand('git-management.addLicense', async (uri?: vscode.Uri) => {
        await addLicense(uri);
    });

    const generateReadmeCmd = vscode.commands.registerCommand('git-management.generateReadme', async (uri?: vscode.Uri) => {
        await generateReadme(uri);
    });

    const templateGenCmd = vscode.commands.registerCommand('git-management.templateGenerator', async (uri?: vscode.Uri) => {
        await openTemplateGenerator(uri);
    });

    context.subscriptions.push(initRepo, gen, compare, cleanCache, addToGitignoreCmd, removeFromGitignoreCmd, addLicenseCmd, generateReadmeCmd, templateGenCmd);
}

async function resolveWorkspaceFolder(uri?: vscode.Uri): Promise<string | undefined> {
    let targetDir: string | undefined = uri?.fsPath;
    if (!targetDir && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        if (vscode.workspace.workspaceFolders.length === 1) {
            targetDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
        } else {
            const pick = await vscode.window.showWorkspaceFolderPick({
                placeHolder: 'Select workspace folder'
            });
            if (!pick) return undefined;
            targetDir = pick.uri.fsPath;
        }
    }
    if (targetDir && fs.existsSync(targetDir) && !fs.statSync(targetDir).isDirectory()) {
        targetDir = path.dirname(targetDir);
    }
    return targetDir;
}

async function addLicense(uri?: vscode.Uri): Promise<void> {
    const targetDir = await resolveWorkspaceFolder(uri);
    if (!targetDir) {
        vscode.window.showErrorMessage('No workspace folder open or directory selected.');
        return;
    }

    const licenseOptions = [
        { label: 'MIT License', id: 'MIT', description: 'Simple and permissive; standard for modern open source' },
        { label: 'Apache License 2.0', id: 'Apache-2.0', description: 'Permissive with patent grant and contributor terms' },
        { label: 'GNU General Public License v3.0', id: 'GPL-3.0', description: 'Strong copyleft; modifications must be GPL-3' },
        { label: 'BSD 3-Clause License', id: 'BSD-3-Clause', description: 'Permissive with notice and advertising disclaimer' },
        { label: 'ISC License', id: 'ISC', description: 'Simplified BSD/MIT equivalent' },
        { label: 'The Unlicense', id: 'Unlicense', description: 'Public domain dedication; no restrictions' }
    ];

    const picked = await vscode.window.showQuickPick(licenseOptions, {
        placeHolder: 'Select an open-source LICENSE template'
    });
    if (!picked) return;

    let defaultAuthor = '';
    try {
        defaultAuthor = (await runGit(targetDir, ['config', 'user.name'])).trim();
    } catch {
        defaultAuthor = os.userInfo().username || '';
    }

    const author = await vscode.window.showInputBox({
        prompt: 'Enter the copyright holder name for the LICENSE',
        value: defaultAuthor,
        placeHolder: 'Full Name or Organization'
    });
    if (author === undefined) return;

    const year = new Date().getFullYear().toString();
    const licenseText = getLicenseTemplate(picked.id, year, author);

    const licensePath = path.join(targetDir, 'LICENSE');
    if (fs.existsSync(licensePath)) {
        const overwrite = await vscode.window.showWarningMessage(
            'A LICENSE file already exists in this folder. Overwrite it?',
            { modal: true },
            'Overwrite',
            'Cancel'
        );
        if (overwrite !== 'Overwrite') return;
    }

    fs.writeFileSync(licensePath, licenseText, 'utf8');
    const doc = await vscode.workspace.openTextDocument(licensePath);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`✅ Generated ${picked.label} in ${path.basename(targetDir)}.`);
}

async function generateReadme(uri?: vscode.Uri): Promise<void> {
    const targetDir = await resolveWorkspaceFolder(uri);
    if (!targetDir) {
        vscode.window.showErrorMessage('No workspace folder open or directory selected.');
        return;
    }

    const folderName = path.basename(targetDir);
    const readmePath = path.join(targetDir, 'README.md');

    if (fs.existsSync(readmePath)) {
        const overwrite = await vscode.window.showWarningMessage(
            'A README.md file already exists in this folder. Overwrite it?',
            { modal: true },
            'Overwrite',
            'Cancel'
        );
        if (overwrite !== 'Overwrite') return;
    }

    const projectName = await vscode.window.showInputBox({
        prompt: 'Enter Project Name',
        value: folderName
    });
    if (!projectName) return;

    const description = await vscode.window.showInputBox({
        prompt: 'Enter a brief description for this project',
        value: `${projectName} - Created with xVSCodeTools`
    });

    const readmeContent = `# ${projectName}\n\n> ${description || 'Project description.'}\n\n## Table of Contents\n- [Features](#features)\n- [Prerequisites](#prerequisites)\n- [Installation](#installation)\n- [Usage](#usage)\n- [License](#license)\n\n## Features\n- 🚀 Fast and lightweight\n- ⚙️ Modular architecture\n- 🛠️ Developer friendly\n\n## Prerequisites\n- VS Code or modern development environment\n\n## Installation\n\`\`\`bash\n# Clone repository\ngit clone <repository-url>\ncd ${folderName}\n\`\`\`\n\n## Usage\n\`\`\`bash\n# Example execution\n\`\`\`\n\n## License\nThis project is licensed under the terms specified in the [LICENSE](LICENSE) file.\n`;

    fs.writeFileSync(readmePath, readmeContent, 'utf8');
    const doc = await vscode.workspace.openTextDocument(readmePath);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`✅ Generated README.md for "${projectName}".`);
}

async function openTemplateGenerator(uri?: vscode.Uri): Promise<void> {
    const actions = [
        { label: '$(diff-ignored) Add to .gitignore & Untrack', id: 'addToGitignore', detail: 'Add selected file or active file to .gitignore and untrack from Git' },
        { label: '$(diff-added) Track & Remove from .gitignore', id: 'removeFromGitignore', detail: 'Remove selected file or active file from .gitignore and track in Git' },
        { label: '$(file-add) Download .gitignore Template', id: 'gitignore', detail: 'Search and download an official GitHub .gitignore template' },
        { label: '$(law) Add LICENSE', id: 'license', detail: 'Scaffold MIT, Apache-2.0, GPL-3.0, BSD, ISC, or Unlicense' },
        { label: '$(book) Generate README.md', id: 'readme', detail: 'Create a structured project README with standard sections' },
        { label: '$(clear-all) Clean Untracked Git Ignore Cache', id: 'cleanCache', detail: 'Untrack cached files that match .gitignore rules' }
    ];

    const pick = await vscode.window.showQuickPick(actions, {
        placeHolder: 'Repository Template Generator - Choose an action'
    });
    if (!pick) return;

    switch (pick.id) {
        case 'addToGitignore':
            vscode.commands.executeCommand('git-management.addToGitignoreAndUntrack', uri);
            break;
        case 'removeFromGitignore':
            vscode.commands.executeCommand('git-management.removeFromGitignoreAndTrack', uri);
            break;
        case 'gitignore':
            vscode.commands.executeCommand('git-management.generateGitignore', uri);
            break;
        case 'license':
            vscode.commands.executeCommand('git-management.addLicense', uri);
            break;
        case 'readme':
            vscode.commands.executeCommand('git-management.generateReadme', uri);
            break;
        case 'cleanCache':
            vscode.commands.executeCommand('git-management.cleanUntrackedCache', uri);
            break;
    }
}

function getLicenseTemplate(id: string, year: string, author: string): string {
    switch (id) {
        case 'MIT':
            return `MIT License\n\nCopyright (c) ${year} ${author}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`;
        case 'Apache-2.0':
            return `                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\nCopyright ${year} ${author}\n\nLicensed under the Apache License, Version 2.0 (the "License");\nyou may not use this file except in compliance with the License.\nYou may obtain a copy of the License at\n\n    http://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software\ndistributed under the License is distributed on an "AS IS" BASIS,\nWITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\nSee the License for the specific language governing permissions and\nlimitations under the License.\n`;
        case 'BSD-3-Clause':
            return `BSD 3-Clause License\n\nCopyright (c) ${year}, ${author}\nAll rights reserved.\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this\n   list of conditions and the following disclaimer.\n\n2. Redistributions in binary form must reproduce the above copyright notice,\n   this list of conditions and the following disclaimer in the documentation\n   and/or other materials provided with the distribution.\n\n3. Neither the name of the copyright holder nor the names of its\n   contributors may be used to endorse or promote products derived from\n   this software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"\nAND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE\nIMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE\nDISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE\nFOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL\nDAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR\nSERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER\nCAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,\nOR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE\nOF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n`;
        case 'ISC':
            return `ISC License\n\nCopyright (c) ${year}, ${author}\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES\nWITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF\nMERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR\nANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES\nWHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN\nACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF\nOR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n`;
        case 'Unlicense':
            return `This is free and unencumbered software released into the public domain.\n\nAnyone is free to copy, modify, publish, use, compile, sell, or\ndistribute this software, either in source code form or as a compiled\nbinary, for any purpose, commercial or non-commercial, and by any\nmeans.\n\nIn jurisdictions that recognize copyright laws, the author or authors\nof this software dedicate any and all copyright interest in the\nsoftware to the public domain. We make this dedication for the benefit\nof the public at large and to the detriment of our heirs and\nsuccessors. We intend this dedication to be an overt act of\nrelinquishment in perpetuity of all present and future rights to this\nsoftware under copyright law.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.\nIN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR\nOTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,\nARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR\nOTHER DEALINGS IN THE SOFTWARE.\n\nFor more information, please refer to <https://unlicense.org>\n`;
        case 'GPL-3.0':
        default:
            return `GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n\nCopyright (C) ${year} ${author}\n\nThis program is free software: you can redistribute it and/or modify\nit under the terms of the GNU General Public License as published by\nthe Free Software Foundation, either version 3 of the License, or\n(at your option) any later version.\n\nThis program is distributed in the hope that it will be useful,\nbut WITHOUT ANY WARRANTY; without even the implied warranty of\nMERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the\nGNU General Public License for more details.\n\nYou should have received a copy of the GNU General Public License\nalong with this program. If not, see <https://www.gnu.org/licenses/>.\n`;
    }
}

async function getRepoRoot(targetPath: string): Promise<string | undefined> {
    const checkDir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
        ? targetPath
        : path.dirname(targetPath);
    try {
        const rootOut = await runGit(checkDir, ['rev-parse', '--show-toplevel']);
        return path.resolve(rootOut.trim());
    } catch {
        return undefined;
    }
}

let cachedIgnoredPathsSet = new Set<string>();
let cachedIgnoredPathsArray: string[] = [];
let preloadTimer: NodeJS.Timeout | undefined;

function addPathVariants(targetSet: Set<string>, absPath: string): void {
    const norm = path.normalize(absPath);
    targetSet.add(norm);
    targetSet.add(norm.toLowerCase());
    const forward = norm.replace(/\\/g, '/');
    targetSet.add(forward);
    targetSet.add(forward.toLowerCase());
    if (norm.length > 2 && norm[1] === ':') {
        const up = norm[0].toUpperCase() + norm.slice(1);
        const low = norm[0].toLowerCase() + norm.slice(1);
        targetSet.add(up);
        targetSet.add(low);
        targetSet.add(up.replace(/\\/g, '/'));
        targetSet.add(low.replace(/\\/g, '/'));
    }
    try {
        const uri = vscode.Uri.file(norm);
        targetSet.add(uri.toString());
        targetSet.add(uri.toString().toLowerCase());
        targetSet.add(uri.toString(true));
        targetSet.add(uri.toString(true).toLowerCase());
        targetSet.add(uri.fsPath);
        targetSet.add(uri.fsPath.toLowerCase());
        targetSet.add(uri.path);
        targetSet.add(uri.path.toLowerCase());
    } catch {
        // ignore URI construction failure
    }
}

function removePathVariants(targetSet: Set<string>, absPath: string): void {
    const norm = path.normalize(absPath);
    targetSet.delete(norm);
    targetSet.delete(norm.toLowerCase());
    const forward = norm.replace(/\\/g, '/');
    targetSet.delete(forward);
    targetSet.delete(forward.toLowerCase());
    if (norm.length > 2 && norm[1] === ':') {
        const up = norm[0].toUpperCase() + norm.slice(1);
        const low = norm[0].toLowerCase() + norm.slice(1);
        targetSet.delete(up);
        targetSet.delete(low);
        targetSet.delete(up.replace(/\\/g, '/'));
        targetSet.delete(low.replace(/\\/g, '/'));
    }
    try {
        const uri = vscode.Uri.file(norm);
        targetSet.delete(uri.toString());
        targetSet.delete(uri.toString().toLowerCase());
        targetSet.delete(uri.toString(true));
        targetSet.delete(uri.toString(true).toLowerCase());
        targetSet.delete(uri.fsPath);
        targetSet.delete(uri.fsPath.toLowerCase());
        targetSet.delete(uri.path);
        targetSet.delete(uri.path.toLowerCase());
    } catch {
        // ignore
    }
}

export function triggerDebouncedPreload(delayMs = 300): void {
    if (preloadTimer) {
        clearTimeout(preloadTimer);
    }
    preloadTimer = setTimeout(() => {
        preloadIgnoredPaths().catch(err => console.error('[xVSCodeTools] Preload error:', err));
    }, delayMs);
}

export async function preloadIgnoredPaths(): Promise<string[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        cachedIgnoredPathsSet.clear();
        cachedIgnoredPathsArray = [];
        await vscode.commands.executeCommand('setContext', 'gitManagement.ignoredPaths', cachedIgnoredPathsArray);
        return cachedIgnoredPathsArray;
    }

    const newSet = new Set<string>();
    const repoRoots = new Set<string>();

    for (const folder of folders) {
        const root = await getRepoRoot(folder.uri.fsPath);
        if (root) {
            repoRoots.add(root);
        }
    }

    for (const repoRoot of repoRoots) {
        // 1. Explicit lines from .gitignore
        const gitignorePath = path.join(repoRoot, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, 'utf8');
                for (let line of content.split(/\r?\n/)) {
                    line = line.trim();
                    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
                    const clean = line.replace(/^\//, '').replace(/\/$/, '');
                    addPathVariants(newSet, path.resolve(repoRoot, clean));
                }
            } catch {
                // ignore read error
            }
        }

        // 2. Both tracked (-c) and untracked (-o) files matching .gitignore
        try {
            const filesOut = await runGit(repoRoot, ['ls-files', '-c', '-o', '-i', '--exclude-standard']);
            for (const line of filesOut.split('\n')) {
                const trimmed = line.trim();
                if (trimmed) {
                    addPathVariants(newSet, path.resolve(repoRoot, trimmed));
                }
            }
        } catch {
            try {
                const statusOut = await runGit(repoRoot, ['status', '--ignored', '--porcelain', '-uall']);
                for (const rawLine of statusOut.split('\n')) {
                    if (!rawLine.startsWith('!! ')) continue;
                    let p = rawLine.slice(3).trim();
                    if (p.startsWith('"') && p.endsWith('"')) {
                        p = p.slice(1, -1);
                    }
                    addPathVariants(newSet, path.resolve(repoRoot, p));
                }
            } catch {
                // ignore
            }
        }

        // 3. Ignored directories
        try {
            const dirsOut = await runGit(repoRoot, ['ls-files', '-c', '-o', '-i', '--exclude-standard', '--directory']);
            for (const line of dirsOut.split('\n')) {
                const trimmed = line.trim();
                if (trimmed) {
                    addPathVariants(newSet, path.resolve(repoRoot, trimmed));
                }
            }
        } catch {
            // ignore
        }
    }

    cachedIgnoredPathsSet = newSet;
    cachedIgnoredPathsArray = Array.from(newSet);
    await vscode.commands.executeCommand('setContext', 'gitManagement.ignoredPaths', cachedIgnoredPathsArray);
    return cachedIgnoredPathsArray;
}

async function isTargetIgnored(targetPath: string, repoRoot: string): Promise<boolean> {
    const norm = path.normalize(targetPath);
    if (cachedIgnoredPathsSet.has(norm) || cachedIgnoredPathsSet.has(norm.toLowerCase())) {
        return true;
    }

    // Check .gitignore explicit rules
    const gitignorePath = path.join(repoRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        try {
            const content = fs.readFileSync(gitignorePath, 'utf8');
            const rel = path.relative(repoRoot, targetPath).split(path.sep).join('/');
            const cleanRel = rel.replace(/^\//, '').replace(/\/$/, '');
            const base = path.basename(targetPath);
            for (let line of content.split(/\r?\n/)) {
                line = line.trim();
                if (!line || line.startsWith('#')) continue;
                const clean = line.replace(/^\//, '').replace(/\/$/, '');
                if (clean === cleanRel || clean === `/${cleanRel}` || clean === base) {
                    return true;
                }
            }
        } catch {
            // ignore
        }
    }

    // Check git check-ignore with --no-index (works on both tracked and untracked files)
    try {
        const rel = path.relative(repoRoot, targetPath);
        const checkOut = await runGit(repoRoot, ['check-ignore', '--no-index', '--', rel]);
        if (checkOut.trim().length > 0) {
            return true;
        }
    } catch {
        // ignore
    }

    return false;
}

export async function addToGitignoreAndUntrack(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
    let targets: vscode.Uri[] = [];
    if (uris && Array.isArray(uris) && uris.length > 0) {
        targets = uris;
    } else if (uri) {
        targets = [uri];
    } else if (vscode.window.activeTextEditor?.document?.uri) {
        targets = [vscode.window.activeTextEditor.document.uri];
    }

    targets = targets.filter(u => u && u.scheme === 'file');

    if (targets.length === 0) {
        vscode.window.showErrorMessage('No file or folder selected to add to .gitignore.');
        return;
    }

    // Smart auto-detection fallback: if all targets are already ignored, perform removeFromGitignoreAndTrack
    let allAlreadyIgnored = targets.length > 0;
    for (const target of targets) {
        const repoRoot = await getRepoRoot(target.fsPath);
        if (!repoRoot || !(await isTargetIgnored(target.fsPath, repoRoot))) {
            allAlreadyIgnored = false;
            break;
        }
    }
    if (allAlreadyIgnored) {
        await removeFromGitignoreAndTrack(uri, uris);
        return;
    }

    // Group targets by repo root
    const repoGroups = new Map<string, { targetPath: string; relPath: string; pattern: string }[]>();
    const skippedGitignore: string[] = [];
    const notInRepo: string[] = [];

    for (const target of targets) {
        const targetPath = path.resolve(target.fsPath);
        if (!fs.existsSync(targetPath)) {
            continue;
        }

        const baseName = path.basename(targetPath);
        if (baseName.toLowerCase() === '.gitignore') {
            skippedGitignore.push(baseName);
            continue;
        }

        const repoRoot = await getRepoRoot(targetPath);
        if (!repoRoot) {
            notInRepo.push(baseName);
            continue;
        }

        const rel = path.relative(repoRoot, targetPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            notInRepo.push(baseName);
            continue;
        }

        let pattern = rel.split(path.sep).join('/');
        try {
            const isDir = fs.statSync(targetPath).isDirectory();
            if (isDir && !pattern.endsWith('/')) {
                pattern += '/';
            }
        } catch {
            // ignore stat failure
        }

        if (!pattern.startsWith('/')) {
            pattern = '/' + pattern;
        }

        const group = repoGroups.get(repoRoot) || [];
        group.push({ targetPath, relPath: rel.split(path.sep).join('/'), pattern });
        repoGroups.set(repoRoot, group);
    }

    if (skippedGitignore.length > 0) {
        vscode.window.showWarningMessage('Cannot add .gitignore itself to .gitignore.');
    }

    if (repoGroups.size === 0) {
        if (notInRepo.length > 0) {
            vscode.window.showErrorMessage(`Selected item${notInRepo.length > 1 ? 's are' : ' is'} not inside a Git repository.`);
        }
        return;
    }

    let totalProcessed = 0;
    let lastGitignorePath = '';

    for (const [repoRoot, items] of repoGroups) {
        const gitignorePath = path.join(repoRoot, '.gitignore');
        lastGitignorePath = gitignorePath;

        let existingContent = '';
        if (fs.existsSync(gitignorePath)) {
            existingContent = fs.readFileSync(gitignorePath, 'utf8');
        }

        const existingLines = existingContent.split(/\r?\n/).map(l => l.trim());
        const patternsToAppend: string[] = [];

        for (const item of items) {
            const pat = item.pattern;
            const clean = pat.replace(/^\//, '');
            const cleanNoSlash = clean.replace(/\/$/, '');
            const alreadyIgnored = existingLines.some(line => {
                if (!line || line.startsWith('#')) return false;
                const l = line.trim();
                const lClean = l.replace(/^\//, '').replace(/\/$/, '');
                return l === pat || l === clean || lClean === cleanNoSlash;
            });

            if (!alreadyIgnored && !patternsToAppend.includes(pat)) {
                patternsToAppend.push(pat);
            }
        }

        if (patternsToAppend.length > 0) {
            let toAppend = patternsToAppend.join('\n') + '\n';
            if (existingContent.length > 0 && !existingContent.endsWith('\n')) {
                toAppend = '\n' + toAppend;
            }
            fs.writeFileSync(gitignorePath, existingContent + toAppend, 'utf8');
        }

        // Untrack each item completely from Git index
        for (const item of items) {
            try {
                await runGit(repoRoot, ['rm', '-r', '--cached', '-f', '--ignore-unmatch', '--', item.relPath]);
            } catch (err: any) {
                console.warn(`[xVSCodeTools] Failed to run git rm --cached for ${item.relPath}:`, err);
            }
            totalProcessed++;

            // Immediately mark in in-memory cache
            addPathVariants(cachedIgnoredPathsSet, item.targetPath);
        }

        // Stage the .gitignore update so git tracking and ignore rules stay in sync
        try {
            await runGit(repoRoot, ['add', '--', '.gitignore']);
        } catch {
            // non-fatal if add fails
        }
    }

    // Update in-memory array & VS Code context key for responsive menus
    cachedIgnoredPathsArray = Array.from(cachedIgnoredPathsSet);
    await vscode.commands.executeCommand('setContext', 'gitManagement.ignoredPaths', cachedIgnoredPathsArray);

    // Refresh VS Code Source Control and Git Repo Manager
    vscode.commands.executeCommand('gitRepoManager.refresh').then(undefined, () => {});
    vscode.commands.executeCommand('git.refresh').then(undefined, () => {});

    // Trigger background sync
    triggerDebouncedPreload(100);

    if (totalProcessed > 0) {
        const itemDescription = totalProcessed === 1
            ? `"${Array.from(repoGroups.values())[0][0].relPath}"`
            : `${totalProcessed} items`;

        const message = `Added ${itemDescription} to .gitignore and untracked from Git (ignored completely).`;
        const openAction = 'Open .gitignore';

        vscode.window.showInformationMessage(message, openAction).then(selected => {
            if (selected === openAction && lastGitignorePath && fs.existsSync(lastGitignorePath)) {
                vscode.workspace.openTextDocument(lastGitignorePath).then(doc => {
                    vscode.window.showTextDocument(doc);
                }, () => {});
            }
        });
    }
}

export async function removeFromGitignoreAndTrack(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
    let targets: vscode.Uri[] = [];
    if (uris && Array.isArray(uris) && uris.length > 0) {
        targets = uris;
    } else if (uri) {
        targets = [uri];
    } else if (vscode.window.activeTextEditor?.document?.uri) {
        targets = [vscode.window.activeTextEditor.document.uri];
    }

    targets = targets.filter(u => u && u.scheme === 'file');

    if (targets.length === 0) {
        vscode.window.showErrorMessage('No file or folder selected to track.');
        return;
    }

    // Smart auto-detection fallback: if none of the targets are ignored, perform addToGitignoreAndUntrack
    let anyIgnored = false;
    for (const target of targets) {
        const repoRoot = await getRepoRoot(target.fsPath);
        if (repoRoot && (await isTargetIgnored(target.fsPath, repoRoot))) {
            anyIgnored = true;
            break;
        }
    }
    if (!anyIgnored) {
        await addToGitignoreAndUntrack(uri, uris);
        return;
    }

    // Group targets by repo root
    const repoGroups = new Map<string, { targetPath: string; relPath: string; pattern: string; baseName: string }[]>();
    const skippedGitignore: string[] = [];
    const notInRepo: string[] = [];

    for (const target of targets) {
        const targetPath = path.resolve(target.fsPath);
        if (!fs.existsSync(targetPath)) {
            continue;
        }

        const baseName = path.basename(targetPath);
        if (baseName.toLowerCase() === '.gitignore') {
            skippedGitignore.push(baseName);
            continue;
        }

        const repoRoot = await getRepoRoot(targetPath);
        if (!repoRoot) {
            notInRepo.push(baseName);
            continue;
        }

        const rel = path.relative(repoRoot, targetPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            notInRepo.push(baseName);
            continue;
        }

        let pattern = rel.split(path.sep).join('/');
        try {
            const isDir = fs.statSync(targetPath).isDirectory();
            if (isDir && !pattern.endsWith('/')) {
                pattern += '/';
            }
        } catch {
            // ignore
        }

        if (!pattern.startsWith('/')) {
            pattern = '/' + pattern;
        }

        const group = repoGroups.get(repoRoot) || [];
        group.push({ targetPath, relPath: rel.split(path.sep).join('/'), pattern, baseName });
        repoGroups.set(repoRoot, group);
    }

    if (skippedGitignore.length > 0) {
        vscode.window.showWarningMessage('Cannot modify .gitignore for .gitignore itself.');
    }

    if (repoGroups.size === 0) {
        if (notInRepo.length > 0) {
            vscode.window.showErrorMessage(`Selected item${notInRepo.length > 1 ? 's are' : ' is'} not inside a Git repository.`);
        }
        return;
    }

    let totalProcessed = 0;
    let lastGitignorePath = '';

    for (const [repoRoot, items] of repoGroups) {
        const gitignorePath = path.join(repoRoot, '.gitignore');
        lastGitignorePath = gitignorePath;

        let gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
        const lines = gitignoreContent.split(/\r?\n/);
        let modifiedGitignore = false;

        const filteredLines = lines.filter(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return true;

            const cleanL = trimmed.replace(/^\//, '').replace(/\/$/, '');
            for (const item of items) {
                const itemCleanRel = item.relPath.replace(/^\//, '').replace(/\/$/, '');
                if (trimmed === item.pattern || trimmed === item.relPath || cleanL === itemCleanRel || cleanL === item.baseName) {
                    modifiedGitignore = true;
                    return false; // Remove this line
                }
            }
            return true;
        });

        // Check if any items are still ignored by wildcards/parent rules, and add negation if needed
        for (const item of items) {
            let isStillIgnored = false;
            try {
                const checkOut = await runGit(repoRoot, ['check-ignore', '--no-index', '--', item.relPath]);
                if (checkOut.trim().length > 0) {
                    isStillIgnored = true;
                }
            } catch {
                isStillIgnored = false;
            }

            if (isStillIgnored) {
                const negation = `!${item.pattern}`;
                if (!filteredLines.includes(negation)) {
                    filteredLines.push(negation);
                    modifiedGitignore = true;
                }
            }
        }

        if (modifiedGitignore) {
            let newContent = filteredLines.join('\n');
            if (newContent.length > 0 && !newContent.endsWith('\n')) {
                newContent += '\n';
            }
            fs.writeFileSync(gitignorePath, newContent, 'utf8');
        }

        // Track each item in Git: git add -f -- <path>
        for (const item of items) {
            try {
                await runGit(repoRoot, ['add', '-f', '--', item.relPath]);
                totalProcessed++;
            } catch (err: any) {
                console.warn(`[xVSCodeTools] Failed to run git add for ${item.relPath}:`, err);
            }

            // Immediately remove from in-memory cache
            removePathVariants(cachedIgnoredPathsSet, item.targetPath);
        }

        // Stage .gitignore
        try {
            await runGit(repoRoot, ['add', '--', '.gitignore']);
        } catch {
            // ignore
        }
    }

    // Update in-memory array & VS Code context key for responsive menus
    cachedIgnoredPathsArray = Array.from(cachedIgnoredPathsSet);
    await vscode.commands.executeCommand('setContext', 'gitManagement.ignoredPaths', cachedIgnoredPathsArray);

    // Refresh VS Code Source Control and Git Repo Manager
    vscode.commands.executeCommand('gitRepoManager.refresh').then(undefined, () => {});
    vscode.commands.executeCommand('git.refresh').then(undefined, () => {});

    // Trigger background sync
    triggerDebouncedPreload(100);

    if (totalProcessed > 0) {
        const itemDescription = totalProcessed === 1
            ? `"${Array.from(repoGroups.values())[0][0].relPath}"`
            : `${totalProcessed} items`;

        const message = `Tracked ${itemDescription} in Git and removed from .gitignore.`;
        const openAction = 'Open .gitignore';

        vscode.window.showInformationMessage(message, openAction).then(selected => {
            if (selected === openAction && lastGitignorePath && fs.existsSync(lastGitignorePath)) {
                vscode.workspace.openTextDocument(lastGitignorePath).then(doc => {
                    vscode.window.showTextDocument(doc);
                }, () => {});
            }
        });
    }
}
