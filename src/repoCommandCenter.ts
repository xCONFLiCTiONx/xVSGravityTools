import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { GitRepository, RepoScanner } from './gitRepoManager';
import { DiffAnalyzer } from './smartCommit/diffAnalyzer';
import { generateCommitMessage } from './smartCommit/extension';

const execFileAsync = promisify(execFile);
let gitActionsOutput: vscode.OutputChannel | undefined;
function getGitActionsOutput(): vscode.OutputChannel {
    if (!gitActionsOutput) gitActionsOutput = vscode.window.createOutputChannel('xVSCodeTools: Git Actions');
    return gitActionsOutput;
}
type RepoHealth = GitRepository & { ahead: number; behind: number; changes: number; hasUpstream: boolean; missingReadme: boolean; missingLicense: boolean; outdated?: number; hasBuild: boolean; hasTest: boolean; error?: string };
type ProjectPort = { port: number; address: string; process: string };
function run(cwd: string, command: string, args: string[], timeout = 120000): Promise<string> {
    const finalArgs = command === 'git' ? ['-c', 'core.fsmonitor=false', ...args] : args;
    return execFileAsync(command, finalArgs, { cwd, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }).then(r => r.stdout);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(limit, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const current = nextIndex++;
            results[current] = await fn(items[current]);
        }
    });
    await Promise.all(workers);
    return results;
}
async function inspect(repo: GitRepository): Promise<RepoHealth> {
    const result: RepoHealth = { ...repo, ahead: 0, behind: 0, changes: 0, hasUpstream: false, missingReadme: true, missingLicense: true, hasBuild: false, hasTest: false };
    try {
        const [status, files] = await Promise.all([run(repo.path, 'git', ['--no-optional-locks', 'status', '--porcelain=v1', '-b']), fs.promises.readdir(repo.path)]);
        const lines = status.split(/\r?\n/).filter(Boolean);
        result.changes = lines.slice(1).length;
        const header = lines[0] || '';
        result.hasUpstream = header.includes('...');
        const aheadMatch = header.match(/ahead (\d+)/);
        const behindMatch = header.match(/behind (\d+)/);
        if (aheadMatch) result.ahead = Number(aheadMatch[1] || 0);
        if (behindMatch) result.behind = Number(behindMatch[1] || 0);
        result.missingReadme = !files.some(f => /^readme(?:\.|$)/i.test(f));
        result.missingLicense = !files.some(f => /^licen[cs]e(?:\.|$)/i.test(f));
        if (files.includes('package.json')) {
            const pkg = JSON.parse(await fs.promises.readFile(path.join(repo.path, 'package.json'), 'utf8'));
            result.hasBuild = typeof pkg.scripts?.build === 'string'; result.hasTest = typeof pkg.scripts?.test === 'string';
            const outdated = await run(repo.path, 'npm', ['outdated', '--json'], 30000).catch(e => typeof e.stdout === 'string' ? e.stdout : '{}');
            try { result.outdated = Object.keys(JSON.parse(outdated || '{}')).length; } catch { result.outdated = 0; }
        }
    } catch (e) { result.error = e instanceof Error ? e.message : String(e); }
    return result;
}

export class RepoCommandCenter {
    private panel?: vscode.WebviewPanel;
    private repos: RepoHealth[] = [];
    private projectTasks: string[] = [];
    private projectErrors: { file: string; line: number; message: string }[] = [];
    private projectPorts: ProjectPort[] = [];
    private busy = false;
    private ollamaKeyConfigured = false;
    constructor(private context: vscode.ExtensionContext, private scanner: RepoScanner) {}

    open() {
        if (this.panel) { this.panel.reveal(); void this.refresh(); return; }
        this.panel = vscode.window.createWebviewPanel('repoCommandCenter', 'Command Center', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
        this.panel.onDidDispose(() => { this.panel = undefined; });
        void this.context.secrets.get('smartCommit.ollamaApiKey').then(key => { this.ollamaKeyConfigured = !!key; this.render(); });
        this.panel.webview.onDidReceiveMessage(async m => {
            if (m.command === 'refresh') await this.refresh();
            if (m.command === 'open' && this.repos[m.index]) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(this.repos[m.index].path), { forceNewWindow: true });
            if (m.command === 'run') await this.runSelected(m.index, m.script);
            if (m.command === 'fix' && this.repos[m.index]) {
                const repo = this.repos[m.index];
                await vscode.commands.executeCommand(m.issue === 'readme' ? 'git-management.generateReadme' : 'git-management.addLicense', vscode.Uri.file(repo.path));
                await this.refresh();
            }
            if (m.command === 'commitAll') await this.commitAll();
            if (m.command === 'pushAll') await this.pushAll();
            if (m.command === 'syncRepo' && typeof m.index === 'number') await this.syncRepo(m.index);
            if (m.command === 'refreshProject') await this.refreshProject();
            if (m.command === 'updateStartupSetting') {
                const config = vscode.workspace.getConfiguration('gitRepoManager');
                await config.update('showCommandCenterOnStartup', !!m.value, vscode.ConfigurationTarget.Global);
            }
            if (m.command === 'setOllamaApiKey') {
                const value = String(m.value || '').trim();
                if (value) await this.context.secrets.store('smartCommit.ollamaApiKey', value);
                else await this.context.secrets.delete('smartCommit.ollamaApiKey');
                this.ollamaKeyConfigured = !!value;
                this.render();
                vscode.window.showInformationMessage(value ? 'Ollama API key saved securely.' : 'Ollama API key cleared.');
            }
            if (m.command === 'loadOllamaModels') {
                const config = vscode.workspace.getConfiguration('smartCommit');
                const baseUrl = (config.get<string>('ollamaUrl', '') || '').trim().replace(/\/+$/, '');
                if (!baseUrl) { this.panel?.webview.postMessage({ command: 'ollamaModels', models: [], error: 'Set the xServer Inference API URL in Commit Settings.' }); return; }
                const apiBase = baseUrl.endsWith('/v1') ? baseUrl : baseUrl + '/v1';
                const key = await this.context.secrets.get('smartCommit.ollamaApiKey');
                try {
                    const response = await fetch(apiBase + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
                    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (await response.text()).slice(0, 300));
                    const data = await response.json() as { data?: Array<{ id?: string }> };
                    const models = [...new Set((data.data || []).map(model => model.id?.trim()).filter((id): id is string => !!id))]
                        .sort().map(name => ({ name }));
                    if (!models.length) throw new Error('The inference gateway returned no available models.');
                    const selectedModel = (config.get<string>('ollamaModel', 'xAssistant') || 'xAssistant').trim();
                    this.panel?.webview.postMessage({ command: 'ollamaModels', models, selectedModel });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.panel?.webview.postMessage({ command: 'ollamaModels', models: [], error: message });
                    vscode.window.showErrorMessage('Could not load xServer inference profiles: ' + message);
                }
            }
            if (m.command === 'updateCommitSettings' && m.values) {
                const config = vscode.workspace.getConfiguration('smartCommit');
                for (const key of ['format', 'emojiStyle', 'includeScope', 'includeBody', 'autoStageIfNone', 'fallbackToUnstaged', 'ollamaUrl', 'ollamaModel'] as const) {
                    if (Object.prototype.hasOwnProperty.call(m.values, key)) await config.update(key, m.values[key], vscode.ConfigurationTarget.Global);
                }
                vscode.window.showInformationMessage('Commit message settings saved.');
            }
        });
        void this.refresh();
    }

    private async refresh() {
        if (!this.panel || this.busy) return;
        this.busy = true; this.render();
        try {
            await this.refreshProject();
            const repos = await this.scanner.scanRepositories();
            this.repos = (await mapWithConcurrency(repos.filter(r => r.syncStatus !== 'none'), 4, inspect)).sort((a,b) => (b.changes + b.behind + (b.missingReadme ? 1 : 0) + (b.missingLicense ? 1 : 0)) - (a.changes + a.behind + (a.missingReadme ? 1 : 0) + (a.missingLicense ? 1 : 0)) || a.name.localeCompare(b.name));
        } finally { this.busy = false; this.render(); }
    }

    private async refreshProject() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) { this.projectTasks = []; this.projectErrors = []; this.projectPorts = []; this.render(); return; }
        const root = path.resolve(folder.uri.fsPath);
        this.projectTasks = vscode.tasks.taskExecutions.filter(execution => {
            const scope = execution.task.scope;
            return scope === vscode.TaskScope.Global || (typeof scope === 'object' && 'uri' in scope && path.resolve(scope.uri.fsPath) === root);
        }).map(execution => execution.task.name);
        const errors: typeof this.projectErrors = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
            if (uri.scheme !== 'file' || !path.resolve(uri.fsPath).startsWith(root + path.sep)) continue;
            for (const d of diagnostics) if (d.severity === vscode.DiagnosticSeverity.Error) errors.push({ file: path.relative(root, uri.fsPath), line: d.range.start.line + 1, message: d.message });
        }
        this.projectErrors = errors.slice(-20).reverse();
        this.projectPorts = await findProjectPorts(root);
        this.render();
    }

    private async commitAll() {
        const targets = this.repos.filter(r => r.changes > 0);
        if (targets.length === 0) {
            vscode.window.showInformationMessage('No repositories have uncommitted changes.');
            return;
        }
        const changed: string[] = [], skipped: string[] = [], failed: string[] = [];
        for (const repo of targets) {
            try {
                const status = await run(repo.path, 'git', ['status', '--porcelain=v1']);
                if (!status.trim()) { skipped.push(repo.name); continue; }
                await run(repo.path, 'git', ['add', '-A']);
                const stagedDiff = await run(repo.path, 'git', ['diff', '--cached', '--no-ext-diff', '--binary']);
                const fileDiffs = DiffAnalyzer.parseDiff(stagedDiff);
                if (fileDiffs.length === 0) { skipped.push(`${repo.name} (no committable changes)`); continue; }
                const message = await generateCommitMessage(fileDiffs);
                await run(repo.path, 'git', ['commit', '-m', message]);
                changed.push(repo.name);
            } catch (e) { failed.push(`${repo.name}: ${errorText(e)}`); }
        }
        await this.refresh();
        const details = [...(changed.length ? [`Committed ${changed.length}: ${changed.join(', ')}`] : []), ...(skipped.length ? [`Already clean: ${skipped.join(', ')}`] : []), ...failed.map(s => `Failed: ${s}`)].join('\n');
        if (failed.length) vscode.window.showWarningMessage(details || 'No repositories had changes to commit.');
        else vscode.window.showInformationMessage(details || 'All changed repositories committed successfully.');
    }

    private async pushAll() {
        const targets = this.repos.filter(r => r.hasUpstream && r.ahead > 0 && r.behind === 0);
        if (targets.length === 0) {
            vscode.window.showInformationMessage('No repositories have outgoing commits ready to push.');
            return;
        }
        const pushed: string[] = [], skipped: string[] = [], failed: string[] = [];
        const output = getGitActionsOutput();
        output.clear();
        output.appendLine(`Push outgoing commits started at ${new Date().toLocaleString()}`);
        output.show(true);
        for (const repo of targets) {
            output.appendLine(`\n[${repo.name}] Checking upstream status...`);
            try {
                const status = await run(repo.path, 'git', ['status', '--porcelain=v1', '-b']);
                const lines = status.split(/\r?\n/).filter(Boolean), header = lines[0] || '';
                const aheadMatch = header.match(/ahead (\d+)/);
                const behindMatch = header.match(/behind (\d+)/);
                const ahead = Number(aheadMatch?.[1] || 0), behind = Number(behindMatch?.[1] || 0);
                if (!header.includes('...') || ahead < 1 || behind > 0) {
                    skipped.push(repo.name);
                    output.appendLine(`Skipped: no safe outgoing commits (ahead ${ahead}, behind ${behind}).`);
                    continue;
                }
                output.appendLine(`Pushing ${ahead} outgoing commit(s)...`);
                output.appendLine(`> git push --progress`);
                await runGitWithOutput(repo.path, ['push', '--progress'], output);
                pushed.push(repo.name);
                output.appendLine('Push completed successfully.');
            } catch (e) {
                const message = errorText(e);
                failed.push(`${repo.name}: ${message}`);
                output.appendLine(`Push failed: ${message}`);
            }
        }
        output.appendLine('\nPush action finished.');
        await this.refresh();
        const details = [...(pushed.length ? [`Pushed ${pushed.length}: ${pushed.join(', ')}`] : []), ...(skipped.length ? [`No safe outgoing commits: ${skipped.join(', ')}`] : []), ...failed.map(s => `Failed: ${s}`)].join('\n');
        if (failed.length) vscode.window.showWarningMessage(details || 'No repositories had outgoing commits to push.');
        else vscode.window.showInformationMessage(details || 'Ready repositories pushed successfully.');
    }

    public async syncSingleRepo(repo: { name: string; path: string }, output: vscode.OutputChannel): Promise<'synced' | 'skipped' | 'up-to-date'> {
        output.appendLine(`\n[${repo.name}] Fetching remote status...`);
        try {
            await run(repo.path, 'git', ['fetch', '--prune'], 30000);
        } catch (e) {
            output.appendLine(`Fetch note: ${errorText(e)}`);
        }

        const status = await run(repo.path, 'git', ['status', '--porcelain=v1', '-b']);
        const lines = status.split(/\r?\n/).filter(Boolean);
        const header = lines[0] || '';
        const hasChanges = lines.slice(1).length > 0;

        if (!header.includes('...')) {
            output.appendLine(`Skipped: No upstream remote branch is tracked.`);
            return 'skipped';
        }

        const tracking = header.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
        let ahead = Number(tracking?.[1] || 0);
        let behind = Number(tracking?.[2] || tracking?.[3] || 0);

        if (behind === 0 && ahead === 0 && !hasChanges) {
            output.appendLine(`Already up to date.`);
            return 'up-to-date';
        }

        if (behind > 0 && hasChanges) {
            output.appendLine(`Cannot pull safely: repository has uncommitted changes. Commit or stash them first.`);
            throw new Error(`Repository has uncommitted changes and cannot pull incoming commits.`);
        }

        let pulled = false, pushed = false;
        if (behind > 0) {
            output.appendLine(`Pulling ${behind} incoming commit(s)...`);
            output.appendLine(`> git pull --progress`);
            await runGitWithOutput(repo.path, ['pull', '--progress'], output);
            output.appendLine(`Pull completed.`);
            pulled = true;
        }

        const statusAfter = await run(repo.path, 'git', ['status', '--porcelain=v1', '-b']);
        const linesAfter = statusAfter.split(/\r?\n/).filter(Boolean);
        const headerAfter = linesAfter[0] || '';
        const trackingAfter = headerAfter.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
        ahead = Number(trackingAfter?.[1] || 0);
        const behindAfter = Number(trackingAfter?.[2] || trackingAfter?.[3] || 0);

        if (behindAfter > 0) {
            output.appendLine(`Warning: still behind upstream by ${behindAfter} commit(s).`);
        }

        if (ahead > 0 && behindAfter === 0) {
            output.appendLine(`Pushing ${ahead} outgoing commit(s)...`);
            output.appendLine(`> git push --progress`);
            await runGitWithOutput(repo.path, ['push', '--progress'], output);
            output.appendLine(`Push completed.`);
            pushed = true;
        }

        if (!pulled && !pushed) {
            output.appendLine(`Already up to date.`);
            return 'up-to-date';
        }

        output.appendLine(`Sync finished successfully.`);
        return 'synced';
    }

    public async syncRepo(index: number) {
        const repo = this.repos[index];
        if (!repo) return;
        const output = getGitActionsOutput();
        output.clear();
        output.appendLine(`Sync started for [${repo.name}] at ${new Date().toLocaleString()}`);
        output.show(true);
        try {
            const res = await this.syncSingleRepo(repo, output);
            if (res === 'synced') vscode.window.showInformationMessage(`[${repo.name}] Synced successfully.`);
            else if (res === 'up-to-date') vscode.window.showInformationMessage(`[${repo.name}] Already up to date.`);
            else vscode.window.showInformationMessage(`[${repo.name}] Skipped: No remote upstream branch tracked.`);
        } catch (e) {
            const message = errorText(e);
            output.appendLine(`Sync failed: ${message}`);
            vscode.window.showErrorMessage(`[${repo.name}] Sync failed: ${message}`);
        } finally {
            await this.refresh();
        }
    }

    public async syncByPath(repoPath: string) {
        const name = path.basename(repoPath);
        const repo = this.repos.find(r => path.resolve(r.path) === path.resolve(repoPath)) || { name, path: repoPath };
        const output = getGitActionsOutput();
        output.clear();
        output.appendLine(`Sync started for [${name}] at ${new Date().toLocaleString()}`);
        output.show(true);
        try {
            const res = await this.syncSingleRepo(repo, output);
            if (res === 'synced') vscode.window.showInformationMessage(`[${name}] Synced successfully.`);
            else if (res === 'up-to-date') vscode.window.showInformationMessage(`[${name}] Already up to date.`);
            else vscode.window.showInformationMessage(`[${name}] Skipped: No remote upstream branch tracked.`);
        } catch (e) {
            const message = errorText(e);
            output.appendLine(`Sync failed: ${message}`);
            vscode.window.showErrorMessage(`[${name}] Sync failed: ${message}`);
        } finally {
            if (this.panel) await this.refresh();
        }
    }

    private async runSelected(index: number, script: 'build'|'test') {
        const repo = this.repos[index]; if (!repo) return;
        try {
            const pkg = JSON.parse(await fs.promises.readFile(path.join(repo.path, 'package.json'), 'utf8'));
            if (!pkg.scripts?.[script]) { vscode.window.showInformationMessage(`${repo.name} has no ${script} script.`); return; }
            const terminal = vscode.window.createTerminal({ name: `${repo.name}: ${script}`, cwd: repo.path }); terminal.show(); terminal.sendText(`npm run ${script}`);
        } catch { vscode.window.showInformationMessage('Build and test buttons currently support npm projects with a package.json.'); }
    }

    private render() {
        if (!this.panel) return;
        const dirty = this.repos.filter(r=>r.changes).length,
              behind = this.repos.filter(r=>r.behind).length,
              ahead = this.repos.filter(r=>r.ahead && !r.behind).length;
        const cards = this.repos.map((r,i) => {
            const isOutOfSync = r.hasUpstream && (r.behind > 0 || r.ahead > 0);
            const syncBtn = !r.hasUpstream
                ? `<button disabled title="Local repository without upstream remote">Local only</button>`
                : isOutOfSync
                    ? `<button data-sync="${i}" class="primaryAction" title="Sync repository (${r.behind ? `${r.behind} incoming` : ''}${r.behind && r.ahead ? ', ' : ''}${r.ahead ? `${r.ahead} outgoing` : ''})">Sync (${r.behind ? `↓${r.behind}` : ''}${r.behind && r.ahead ? ' ' : ''}${r.ahead ? `↑${r.ahead}` : ''})</button>`
                    : `<button data-sync="${i}" title="Repository is already in sync with remote. Click to check for remote updates.">Sync</button>`;
            return `<article class="repo"><div class="repohead"><div><h2>${esc(r.name)}</h2><div class="path">${esc(r.path)}</div></div><div class="repoHeadActions">${syncBtn}<button data-open="${i}">Open</button></div></div><div class="signals">${pill(r.changes?`${r.changes} changed`:'Clean',r.changes?'warn':'ok')}${pill(r.behind?`${r.behind} incoming`:'No incoming',r.behind?'bad':'ok')}${pill(r.ahead?`${r.ahead} outgoing`:'No outgoing',r.ahead?'info':'muted')}${r.missingReadme?`<button class="issue" data-fix="readme" data-index="${i}">Create README</button>`:''}${r.missingLicense?`<button class="issue" data-fix="license" data-index="${i}">Add license</button>`:''}${r.outdated?pill(`${r.outdated} outdated packages`,'warn'):''}${r.error?pill('Check failed','bad'):''}</div><div class="repofoot"><span>${esc(r.branch||'Branch unknown')}</span><div>${r.hasBuild?`<button data-run="build" data-index="${i}">Build</button>`:''}${r.hasTest?`<button data-run="test" data-index="${i}">Test</button>`:''}</div></div></article>`;
        }).join('');
        const toolCards = this.repos.filter(r=>r.hasBuild||r.hasTest).map((r,i)=>`<article class="repo"><h2>${esc(r.name)}</h2><div class="path">${esc(r.path)}</div><div class="actions">${r.hasBuild?`<button data-run="build" data-index="${this.repos.indexOf(r)}">Build</button>`:''}${r.hasTest?`<button data-run="test" data-index="${this.repos.indexOf(r)}">Test</button>`:''}</div></article>`).join('');
        const workspace = vscode.workspace.workspaceFolders?.[0];
        const showOnStartup = vscode.workspace.getConfiguration('gitRepoManager').get<boolean>('showCommandCenterOnStartup', false);
        const commitConfig = vscode.workspace.getConfiguration('smartCommit');
        const format = commitConfig.get<string>('format', 'conventional');
        const emojiStyle = commitConfig.get<string>('emojiStyle', 'gitmoji');
        const ollamaKeyConfigured = this.ollamaKeyConfigured;
        const commitSettings = `<h2 class="sectionTitle">Commit message settings</h2><p class="note">These options also control commits started from this Command Center.</p><div class="settingsGrid"><label>Default style<select id="commitFormat"><option value="conventional"${format==='conventional'?' selected':''}>Conventional</option><option value="emoji"${format==='emoji'?' selected':''}>Emoji</option><option value="simple"${format==='simple'?' selected':''}>Simple</option><option value="detailed"${format==='detailed'?' selected':''}>Detailed</option></select></label><label>Emoji set<select id="emojiStyle"><option value="gitmoji"${emojiStyle==='gitmoji'?' selected':''}>Gitmoji</option><option value="simple"${emojiStyle==='simple'?' selected':''}>Simple</option></select></label><label class="check"><input id="includeScope" type="checkbox"${commitConfig.get<boolean>('includeScope',true)?' checked':''}> Include detected scope</label><label class="check"><input id="includeBody" type="checkbox"${commitConfig.get<boolean>('includeBody',false)?' checked':''}> Include changed files in message body</label><label class="check"><input id="autoStageIfNone" type="checkbox"${commitConfig.get<boolean>('autoStageIfNone',false)?' checked':''}> Automatically stage if nothing is staged</label><label class="check"><input id="fallbackToUnstaged" type="checkbox"${commitConfig.get<boolean>('fallbackToUnstaged',true)?' checked':''}> Use unstaged changes if nothing is staged</label><label>xServer Inference API URL<input id="ollamaUrl" type="text" placeholder="https://inference.example.com/v1" value="${esc(commitConfig.get<string>('ollamaUrl',''))}"></label><label>Model<select id="ollamaModelSelect"><option value="xAssistant" selected>xAssistant</option></select></label><label>API key <span class="muted">${ollamaKeyConfigured?'Configured and stored securely':'Not configured'}</span><input id="ollamaApiKey" type="password" autocomplete="new-password" placeholder="Gateway API key"></label></div><div class="actions"><button id="saveCommitSettings">Save commit settings</button><button id="refreshOllamaModels">Test connection / refresh profile</button><button id="saveOllamaApiKey">Save API key</button><button id="clearOllamaApiKey">Clear API key</button></div><p class="note" id="ollamaStatus">Uses the xServer shared inference gateway. Select any model exposed by the gateway; models are managed on xServer.</p>`;
        const projectContent = !workspace ? '<p>Open a project folder to view its ports, tasks, and errors.</p>' : `<p class="path">${esc(workspace.name)} · ${esc(workspace.uri.fsPath)}</p><div class="stats"><div class="stat">Listening ports<strong>${this.projectPorts.length}</strong></div><div class="stat">Running tasks<strong>${this.projectTasks.length}</strong></div><div class="stat">Recent errors<strong>${this.projectErrors.length}</strong></div></div><h2 class="sectionTitle">Server ports</h2><div class="grid">${this.projectPorts.map(p=>`<article class="repo"><h2>${esc(p.address)}:${p.port}</h2><div class="path">${esc(p.process)}</div></article>`).join('')||'<p>No project-associated listening ports detected.</p>'}</div><h2 class="sectionTitle">Running tasks</h2><div class="grid">${this.projectTasks.map(t=>`<article class="repo"><h2>${esc(t)}</h2></article>`).join('')||'<p>No running tasks.</p>'}</div><h2 class="sectionTitle">Recent errors</h2><div class="grid">${this.projectErrors.map(e=>`<article class="repo"><h2>${esc(e.file)}:${e.line}</h2><div>${esc(e.message)}</div></article>`).join('')||'<p>No current project errors.</p>'}</div>`;
        this.panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
            *{box-sizing:border-box}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:clamp(10px,2vw,20px);max-width:1500px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}h1{font-size:clamp(20px,3vw,28px);margin:0 0 4px}.sub,.path{opacity:.7}.sub{font-size:13px}.top button{white-space:nowrap}.topActions{display:flex;align-items:center;gap:14px}.startupCheck{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.9;cursor:pointer;user-select:none}.startupCheck input{cursor:pointer;margin:0}.tabs{position:sticky;top:0;z-index:2;display:flex;gap:5px;overflow:auto;padding:8px 0 12px;background:var(--vscode-editor-background)}.tab{flex:0 0 auto;background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border)}.tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.page{display:none}.page.active{display:block}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0 18px}.stat,.repo,.actionCard{border:1px solid var(--vscode-panel-border);border-radius:12px;background:var(--vscode-sideBar-background);padding:14px}.stat{font-size:13px}.stat strong{display:block;font-size:24px;margin-top:5px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:12px}.repo h2{margin:0 0 5px;font-size:17px}.repohead,.repofoot{display:flex;justify-content:space-between;align-items:center;gap:8px}.repohead{align-items:flex-start}.repoHeadActions{display:flex;gap:6px;align-items:center}.path{font-size:12px;overflow-wrap:anywhere}.signals{display:flex;flex-wrap:wrap;gap:6px;margin:15px 0}.pill{border:1px solid;border-radius:999px;padding:4px 8px;font-size:12px}.ok{color:#4ec98a}.warn{color:#e5bd59}.bad{color:#f27676}.info{color:#70adff}.muted{opacity:.68}.issue{border:1px solid #e5bd59!important}.repofoot{border-top:1px solid var(--vscode-panel-border);padding-top:10px;opacity:.85}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.actionGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px}.actionCard h2{margin:0 0 6px;font-size:17px}.actionCard p{opacity:.75;font-size:13px;min-height:34px}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:5px;padding:5px 8px;cursor:pointer;font:inherit;font-size:12px;line-height:1.2}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.5;cursor:default}.primaryAction{width:100%;min-height:30px}.note{font-size:12px;opacity:.7;margin:10px 0}.sectionTitle{font-size:19px;margin:8px 0 12px}.settingsGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:14px;max-width:900px;margin:18px 0}.settingsGrid label{display:flex;flex-direction:column;gap:7px}.settingsGrid .check{flex-direction:row;align-items:center}.settingsGrid select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:7px;border-radius:4px}.diffInputs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.diffPane label{display:block;font-weight:600;margin:0 0 7px}.diffPane textarea{width:100%;height:260px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:6px;padding:10px;font:13px var(--vscode-editor-font-family,monospace);tab-size:4}.diffActions{display:flex;align-items:center;gap:10px;margin:12px 0}.diffSummary{font-size:12px;opacity:.75}.diffOutput{overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-editor-background);font:13px var(--vscode-editor-font-family,monospace)}.diffRow{display:flex;min-height:22px;white-space:pre}.diffRow .lineNo{flex:0 0 42px;text-align:right;padding:2px 7px;opacity:.55;user-select:none;border-right:1px solid var(--vscode-panel-border)}.diffRow .marker{flex:0 0 24px;text-align:center;padding:2px 0;user-select:none}.diffRow .code{padding:2px 10px;min-width:0}.diffRow.add{background:rgba(46,160,67,.18)}.diffRow.remove{background:rgba(248,81,73,.18)}.diffRow.add .marker{color:#4ec98a}.diffRow.remove .marker{color:#f27676}.diffEmpty{padding:14px;opacity:.7}@media(max-width:600px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}header{align-items:flex-start}.repofoot{align-items:flex-start}.diffInputs{grid-template-columns:1fr}.diffPane textarea{height:180px}}
            </style></head><body><header><div><h1>Command Center</h1><div class="sub">Repositories, Git, builds, and project tools</div></div><div class="topActions"><label class="startupCheck"><input id="startupCheck" type="checkbox"${showOnStartup?' checked':''}> Open on startup</label><button class="top" id="refresh">${this.busy?'Scanning…':'Refresh'}</button></div></header><nav class="tabs" role="tablist"><button class="tab active" data-tab="overview">Overview</button><button class="tab" data-tab="tools">Build & test</button><button class="tab" data-tab="project">Project status</button><button class="tab" data-tab="diff">Diff viewer</button><button class="tab" data-tab="commitSettings">Commit settings</button></nav>
            <main><section class="page active" id="overview"><div class="stats"><div class="stat">Repositories<strong>${this.repos.length}</strong></div><div class="stat">Need attention<strong>${this.repos.filter(r=>r.changes||r.behind||r.missingReadme||r.missingLicense||r.error).length}</strong></div><div class="stat">With changes<strong>${dirty}</strong></div><div class="stat">Outgoing commits<strong>${ahead}</strong></div></div><h2 class="sectionTitle">Needs attention</h2><div class="grid">${this.repos.filter(r=>r.changes||r.behind||r.missingReadme||r.missingLicense||r.error).slice(0,6).map(r=>cards.split('</article>')[this.repos.indexOf(r)]+'</article>').join('')||'<p>All scanned repositories look good.</p>'}</div><p class="note">${behind} repositories have incoming commits. Review or sync those to stay up to date.</p><h2 class="sectionTitle">Git actions</h2><div class="actionGrid"><article class="actionCard"><h2>Commit all changes</h2><p>Generates a commit message from each repository's own changes and commits its working tree.</p><button id="commit" class="primaryAction" ${dirty?'':'disabled'}>Commit changed repositories · ${dirty}</button></article><article class="actionCard"><h2>Push outgoing commits</h2><p>Pushes repositories with outgoing commits and no known incoming commits.</p><button id="push" class="primaryAction" ${ahead?'':'disabled'}>Push ready repositories · ${ahead}</button></article></div><p class="note">Only repositories that require action are processed. Repositories with no pending commits or changes are never touched.</p><h2 class="sectionTitle">All repositories</h2><div class="grid">${cards||'<p>No Git repositories found. Configure Git Repo Manager search directories first.</p>'}</div></section>
            <section class="page" id="tools"><h2 class="sectionTitle">Build and test</h2><div class="grid">${toolCards||'<p>No npm build or test scripts were found in the scanned repositories.</p>'}</div></section><section class="page" id="project"><header><div><h2 class="sectionTitle">Current project status</h2></div><button id="refreshProject">Refresh project</button></header>${projectContent}</section>
            <section class="page" id="diff"><h2 class="sectionTitle">Text diff</h2><p class="note">Paste the original text on the left and the revised text on the right. Compare to see a unified diff.</p><div class="diffInputs"><div class="diffPane"><label for="diffBefore">Original</label><textarea id="diffBefore" spellcheck="false" placeholder="Paste original text…"></textarea></div><div class="diffPane"><label for="diffAfter">Revised</label><textarea id="diffAfter" spellcheck="false" placeholder="Paste revised text…"></textarea></div></div><div class="diffActions"><button id="compareDiff">Compare</button><span class="diffSummary" id="diffSummary">Paste text in both panes, then compare.</span></div><div class="diffOutput" id="diffOutput" aria-live="polite"><div class="diffEmpty">Your diff will appear here.</div></div></section><section class="page" id="commitSettings">${commitSettings}</section></main>
            <script>const api=acquireVsCodeApi();window.addEventListener('message',event=>{const m=event.data;if(m.command==='ollamaModels'){const select=document.getElementById('ollamaModelSelect');const current=m.selectedModel||select.value;select.innerHTML='';(m.models||[]).forEach(model=>{const option=document.createElement('option');option.value=model.name;option.textContent=model.name+(model.size?' · '+(model.size/1e9).toFixed(1)+' GB':'');select.appendChild(option)});if([...select.options].some(o=>o.value===current))select.value=current;else if(current){const option=document.createElement('option');option.value=current;option.textContent=current+' (configured; not installed)';select.insertBefore(option,select.firstChild);select.value=current;}document.getElementById('ollamaStatus').textContent=m.error||((m.models||[]).length+' model(s) available on the inference gateway.');}if(m.command==='refreshOllamaModels')api.postMessage({command:'loadOllamaModels'});});const startupCheck=document.getElementById('startupCheck');if(startupCheck){startupCheck.onchange=()=>api.postMessage({command:'updateStartupSetting',value:startupCheck.checked});}document.getElementById('refresh').onclick=()=>api.postMessage({command:'refresh'});document.getElementById('refreshProject').onclick=()=>api.postMessage({command:'refreshProject'});document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab,.page').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.getElementById(b.dataset.tab).classList.add('active')});document.getElementById('commit').onclick=()=>api.postMessage({command:'commitAll'});document.getElementById('push').onclick=()=>api.postMessage({command:'pushAll'});document.querySelectorAll('[data-sync]').forEach(b=>b.onclick=()=>api.postMessage({command:'syncRepo',index:+b.dataset.sync}));document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>api.postMessage({command:'open',index:+b.dataset.open}));document.querySelectorAll('[data-run]').forEach(b=>b.onclick=()=>api.postMessage({command:'run',index:+b.dataset.index,script:b.dataset.run}));document.querySelectorAll('[data-fix]').forEach(b=>b.onclick=()=>api.postMessage({command:'fix',index:+b.dataset.index,issue:b.dataset.fix}));document.getElementById('refreshOllamaModels').onclick=()=>api.postMessage({command:'loadOllamaModels'});document.getElementById('saveOllamaApiKey').onclick=()=>api.postMessage({command:'setOllamaApiKey',value:document.getElementById('ollamaApiKey').value});document.getElementById('clearOllamaApiKey').onclick=()=>{document.getElementById('ollamaApiKey').value='';api.postMessage({command:'setOllamaApiKey',value:''});};document.getElementById('saveCommitSettings').onclick=()=>api.postMessage({command:'updateCommitSettings',values:{format:document.getElementById('commitFormat').value,emojiStyle:document.getElementById('emojiStyle').value,includeScope:document.getElementById('includeScope').checked,includeBody:document.getElementById('includeBody').checked,autoStageIfNone:document.getElementById('autoStageIfNone').checked,fallbackToUnstaged:document.getElementById('fallbackToUnstaged').checked,ollamaUrl:document.getElementById('ollamaUrl').value.trim(),ollamaModel:document.getElementById('ollamaModelSelect').value.trim()}});api.postMessage({command:'loadOllamaModels'});const diffEsc=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));document.getElementById('compareDiff').onclick=()=>{const a=document.getElementById('diffBefore').value.split(/\\r?\\n/),b=document.getElementById('diffAfter').value.split(/\\r?\\n/),n=a.length,m=b.length,out=document.getElementById('diffOutput'),summary=document.getElementById('diffSummary');if((n+1)*(m+1)>4000000){summary.textContent='These inputs are too large for an in-browser comparison. Try smaller text.';out.innerHTML='<div class="diffEmpty">Input exceeds the comparison limit.</div>';return}const dp=Array.from({length:n+1},()=>new Uint32Array(m+1));for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);const rows=[];let i=0,j=0,oldNo=1,newNo=1,added=0,removed=0;while(i<n||j<m){if(i<n&&j<m&&a[i]===b[j]){rows.push({kind:'context',old:oldNo++,next:newNo++,text:a[i++]});j++}else if(j<m&&(i===n||dp[i][j+1]>dp[i+1][j])){rows.push({kind:'add',old:'',next:newNo++,text:b[j++]});added++}else{rows.push({kind:'remove',old:oldNo++,next:'',text:a[i++]});removed++}}out.innerHTML=rows.map(r=>'<div class="diffRow '+r.kind+'"><span class="lineNo">'+r.old+'</span><span class="lineNo">'+r.next+'</span><span class="marker">'+(r.kind==='add'?'+':r.kind==='remove'?'-':' ')+'</span><span class="code">'+diffEsc(r.text||' ')+'</span></div>').join('')||'<div class="diffEmpty">No differences.</div>';summary.textContent=added||removed?added+' additions, '+removed+' removals':'Files are identical.'};</script></body></html>`;
    }
}
function errorText(e: unknown): string { const anyError=e as {stderr?:string;message?:string}; return (anyError.stderr||anyError.message||String(e)).trim().slice(0,240); }
async function findProjectPorts(root: string): Promise<ProjectPort[]> {
    try {
        if (process.platform === 'win32') {
            const safeRoot = root.replace(/'/g, "''");
            const script = `$root='${safeRoot}'; $procs=@{}; Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId]=$_.CommandLine }; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $cmd=$procs[[int]$_.OwningProcess]; if ($cmd -and $cmd.Contains($root)) { [pscustomobject]@{port=$_.LocalPort;address=$_.LocalAddress;process=$cmd} } } | ConvertTo-Json -Compress`;
            const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
            const parsed = JSON.parse(stdout || '[]');
            return (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).map((p: any) => ({ port: Number(p.port), address: String(p.address), process: String(p.process) }));
        }
        const { stdout } = await execFileAsync('sh', ['-lc', 'ss -ltnp'], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
        const found: ProjectPort[] = [];
        for (const line of stdout.split(/\r?\n/).slice(1)) {
            const match = line.match(/\s+(\S+):(\d+)\s+.*pid=(\d+)/);
            if (!match) continue;
            const pid = match[3], command = await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
            const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => '');
            if (cwd === root || command.includes(root)) found.push({ address: match[1], port: Number(match[2]), process: command.replace(/\0/g, ' ').trim() || `PID ${pid}` });
        }
        return found;
    } catch { return []; }
}
function runGitWithOutput(cwd: string, args: string[], output: vscode.OutputChannel): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, windowsHide: true });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => output.append(String(chunk)));
        child.stderr.on('data', chunk => output.append(String(chunk)));
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`git exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
        });
    });
}
function esc(s: string): string { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
function pill(text: string, cls: string): string { return `<span class="pill ${cls}">${esc(text)}</span>`; }
