import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

function getXServerConfig(): { host: string; gitRoot: string; adminTarget: string } {
    const config = vscode.workspace.getConfiguration('xVSCodeTools.xServer');
    const host = (config.get<string>('host') ?? '').trim();
    const gitRoot = ((config.get<string>('gitRoot') ?? '/srv/git').trim() || '/srv/git').replace(/\/+$/, '');
    const adminTarget = (config.get<string>('adminTarget') ?? '').trim();
    return { host, gitRoot, adminTarget };
}

async function promptOpenXServerSettings(settingKey: string, label: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
        `${label} is not configured. Set "${settingKey}" in VS Code Settings first.`,
        'Open Settings'
    );
    if (choice === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', settingKey);
    }
}

function runGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error((stderr || stdout || error.message).trim()));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

async function resolveTarget(uri?: vscode.Uri): Promise<string | undefined> {
    let target = uri?.fsPath;

    if (!target) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 1) {
            target = folders[0].uri.fsPath;
        } else if (folders.length > 1) {
            target = (await vscode.window.showWorkspaceFolderPick({
                placeHolder: 'Select the project to connect to xServer'
            }))?.uri.fsPath;
        }
    }

    if (!target) return undefined;

    try {
        if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
            target = path.dirname(target);
        }
    } catch {
        // Git will report a useful error if the selected path is unavailable.
    }

    try {
        return (await runGit(target, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
        vscode.window.showErrorMessage('The selected folder is not inside a Git repository.');
        return undefined;
    }
}

function getSuggestedRepoName(repoRoot: string, originUrl?: string): string {
    if (originUrl) {
        const cleanUrl = originUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
        const leaf = cleanUrl.split(/[/:\\]/).pop() ?? '';
        if (leaf) return leaf.replace(/\.git$/i, '');
    }

    return path.basename(repoRoot).replace(/^\.+/, '').replace(/\s+/g, '-');
}

async function nextBackupRemoteName(repoRoot: string): Promise<string> {
    const remotes = (await runGit(repoRoot, ['remote'])).split(/\r?\n/).filter(Boolean);
    if (!remotes.includes('github')) return 'github';

    let suffix = 2;
    while (remotes.includes(`github-${suffix}`)) suffix++;
    return `github-${suffix}`;
}

export function activateXServerRemote(context: vscode.ExtensionContext): void {
    const command = vscode.commands.registerCommand(
        'git-management.configureXServerOrigin',
        async (uri?: vscode.Uri) => {
            const repoRoot = await resolveTarget(uri);
            if (!repoRoot) return;

            let currentOrigin: string | undefined;
            try {
                currentOrigin = await runGit(repoRoot, ['remote', 'get-url', 'origin']);
            } catch {
                currentOrigin = undefined;
            }

            const suggestedName = getSuggestedRepoName(repoRoot, currentOrigin);
            const repoName = await vscode.window.showInputBox({
                title: 'Connect project to xServer',
                prompt: 'Enter the bare repository name on xServer (the .git suffix is added automatically).',
                value: suggestedName,
                placeHolder: 'Example: Dev-Vault',
                validateInput: value => {
                    const trimmed = value.trim();
                    if (!trimmed) return 'Repository name cannot be empty.';
                    if (/[\\/\s]/.test(trimmed)) return 'Use the exact repository name without spaces or path separators.';
                    if (trimmed.endsWith('.git')) return 'Enter the name without the .git suffix.';
                    return undefined;
                }
            });
            if (repoName === undefined) return;

            const { host, gitRoot } = getXServerConfig();
            if (!host) {
                await promptOpenXServerSettings('xVSCodeTools.xServer.host', 'xServer host');
                return;
            }

            const remoteUrl = `git@${host}:${gitRoot}/${repoName.trim()}.git`;

            if (currentOrigin === remoteUrl) {
                vscode.window.showInformationMessage(`xServer is already configured as origin for ${path.basename(repoRoot)}.`);
                return;
            }

            let backupName: string | undefined;
            if (currentOrigin) {
                backupName = await nextBackupRemoteName(repoRoot);
                const choice = await vscode.window.showWarningMessage(
                    `This repository already has origin:\n${currentOrigin}\n\nReplace origin with xServer? The existing remote will be preserved as "${backupName}". No commits will be pushed or pulled.`,
                    { modal: true },
                    'Preserve Existing & Set xServer'
                );
                if (choice !== 'Preserve Existing & Set xServer') return;
            }

            try {
                if (currentOrigin && backupName) {
                    await runGit(repoRoot, ['remote', 'rename', 'origin', backupName]);
                }

                try {
                    await runGit(repoRoot, ['remote', 'add', 'origin', remoteUrl]);
                } catch (error) {
                    if (currentOrigin && backupName) {
                        try {
                            await runGit(repoRoot, ['remote', 'rename', backupName, 'origin']);
                        } catch {
                            vscode.window.showErrorMessage(
                                `Could not configure xServer, and automatic rollback failed. The previous origin is preserved as "${backupName}". Error: ${error instanceof Error ? error.message : String(error)}`
                            );
                            return;
                        }
                    }
                    throw error;
                }

                vscode.window.showInformationMessage(
                    `xServer is now origin for ${path.basename(repoRoot)}. Existing remote: ${backupName ?? 'none'}. No files or commits were changed.`
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Could not configure xServer origin: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
    );

    context.subscriptions.push(command, vscode.commands.registerCommand('git-management.deleteXServerRepository', deleteXServerRepository));
}


const XSERVER_REPO_HELPER = '/usr/local/sbin/xserver-git-repo';

function runXServerAdmin(adminTarget: string, operation: '--list' | '--delete', repositoryName?: string): Promise<string> {
    if (operation === '--delete' && (!repositoryName ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repositoryName) ||
        repositoryName.includes('..') || repositoryName.endsWith('.'))) {
        return Promise.reject(new Error('Invalid xServer repository name.'));
    }

    const remoteCommand = operation === '--list'
        ? `sudo -n ${XSERVER_REPO_HELPER} --list`
        : `sudo -n ${XSERVER_REPO_HELPER} --delete '${repositoryName}'`;

    return new Promise((resolve, reject) => {
        execFile(
            'ssh',
            [
                '-o', 'BatchMode=yes',
                '-o', 'ConnectTimeout=5',
                '-o', 'ServerAliveInterval=5',
                adminTarget,
                remoteCommand
            ],
            { windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    const detail = (stderr || stdout || error.message).trim();
                    reject(new Error(detail || 'SSH command failed.'));
                    return;
                }
                resolve(stdout.trim());
            }
        );
    });
}

async function deleteXServerRepository(): Promise<void> {
    const { adminTarget, gitRoot } = getXServerConfig();
    if (!adminTarget) {
        await promptOpenXServerSettings('xVSCodeTools.xServer.adminTarget', 'xServer admin SSH target');
        return;
    }

    let output: string;
    try {
        output = await runXServerAdmin(adminTarget, '--list');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            `Could not list repositories on xServer. Verify SSH access for ${adminTarget} and install the xServer Git repository manager. ${detail}`
        );
        return;
    }

    const repositories = output
        .split(/\r?\n/)
        .map(name => name.trim())
        .filter(name =>
            /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
            !name.includes('..') &&
            !name.endsWith('.')
        );

    if (repositories.length === 0) {
        vscode.window.showInformationMessage('No bare Git repositories were found on xServer.');
        return;
    }

    const selected = await vscode.window.showQuickPick(
        repositories.map(name => ({
            label: name,
            description: `${gitRoot}/${name}.git`,
            detail: 'xServer bare repository'
        })),
        {
            title: 'Delete Repository from xServer',
            placeHolder: 'Select the server-side repository to permanently delete',
            matchOnDescription: true,
            ignoreFocusOut: true
        }
    );
    if (!selected) return;

    const repositoryPath = `${gitRoot}/${selected.label}.git`;
    const confirmation = await vscode.window.showWarningMessage(
        `Permanently delete this repository from xServer?\n\n${repositoryPath}\n\nThis removes the bare server repository only. Your local working copy and GitHub/other remotes will not be changed. This cannot be undone.`,
        { modal: true },
        'Permanently Delete from xServer'
    );
    if (confirmation !== 'Permanently Delete from xServer') return;

    try {
        const result = await runXServerAdmin(adminTarget, '--delete', selected.label);
        vscode.window.showInformationMessage(
            `Deleted xServer repository "${selected.label}". Local files and other remotes were not changed.`
        );
        if (result && !result.includes(`DELETED ${selected.label}`)) {
            console.log(`[xVSCodeTools] xServer repository deletion response: ${result}`);
        }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            `Could not delete xServer repository "${selected.label}": ${detail}`
        );
    }
}
