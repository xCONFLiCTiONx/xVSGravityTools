import * as vscode from 'vscode';
import { execGit } from './gitProcess';

const RECOMMENDED: Array<{ key: string; value: string; reason: string }> = [
    { key: 'init.defaultBranch', value: 'main', reason: 'Use main as the default branch for new repositories' },
    { key: 'fetch.prune', value: 'true', reason: 'Remove stale remote tracking references on fetch' },
    { key: 'pull.ff', value: 'only', reason: 'Avoid creating merge commits on pull; stop if a fast-forward is not possible' },
    { key: 'push.autoSetupRemote', value: 'true', reason: 'Set the upstream automatically when pushing a new branch' }
];

async function git(args: string[]): Promise<string> {
    const stdout = await execGit(args, { maxBuffer: 1024 * 1024, timeoutMs: 15000 });
    return stdout.trim();
}

export async function auditGlobalGitConfig(): Promise<void> {
    let existing: Map<string, string>;
    let configPath: string;
    try {
        const [list, path] = await Promise.all([
            git(['config', '--global', '--list', '--null']),
            git(['config', '--global', '--show-origin', '--list'])
        ]);
        existing = new Map(list.split('\0').filter(Boolean).map(entry => {
            const index = entry.indexOf('\n');
            return [index < 0 ? entry : entry.slice(0, index), index < 0 ? '' : entry.slice(index + 1)];
        }));
        const origin = path.match(/^file:(.+?)\s/m);
        configPath = origin?.[1] || 'Git global configuration file';
    } catch (error) {
        vscode.window.showErrorMessage(`Could not read global Git configuration: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    const needsUpdate = RECOMMENDED.filter(item => existing.get(item.key) !== item.value);
    const report = RECOMMENDED.map(item => {
        const current = existing.get(item.key);
        return `${current === undefined ? '○' : current === item.value ? '✓' : '!'} ${item.key}: ${current ?? `not set (suggested: ${item.value})`} — ${item.reason}`;
    }).join('\n');
    const selection = await vscode.window.showInformationMessage(
        `Global Git settings (${configPath})\n\n${report}`,
        ...(needsUpdate.length ? ['Review suggested settings'] : ['Close'])
    );
    if (selection !== 'Review suggested settings') return;

    const selected = await vscode.window.showQuickPick(
        needsUpdate.map(item => ({ label: item.key, description: `${existing.has(item.key) ? `${existing.get(item.key)} → ` : ''}${item.value} — ${item.reason}`, picked: true, item })),
        { canPickMany: true, placeHolder: 'Select recommended settings to add or update in your global Git config' }
    );
    if (!selected?.length) return;
    const confirm = await vscode.window.showWarningMessage(
        `Add ${selected.length} setting(s) to your global Git configuration?`,
        { modal: true }, 'Apply'
    );
    if (confirm !== 'Apply') return;

    try {
        for (const { item } of selected) await git(['config', '--global', item.key, item.value]);
        vscode.window.showInformationMessage(`Applied ${selected.length} setting(s) to ${configPath}.`);
    } catch (error) {
        vscode.window.showErrorMessage(`Could not update global Git configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
}
