import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitRepository, RepoScanner } from './gitRepoManager';
import { execGit, spawnGitWithOutput } from './gitProcess';
import { DiffAnalyzer } from './smartCommit/diffAnalyzer';
import { generateCommitMessage } from './smartCommit/extension';

const execFileAsync = promisify(execFile);
let gitActionsOutput: vscode.OutputChannel | undefined;

function getGitActionsOutput(): vscode.OutputChannel {
  if (!gitActionsOutput) gitActionsOutput = vscode.window.createOutputChannel('xVSGravityTools: Git Actions');
  return gitActionsOutput;
}

type RepoHealth = GitRepository & {
  ahead: number;
  behind: number;
  changes: number;
  hasUpstream: boolean;
  missingReadme: boolean;
  missingLicense: boolean;
  outdated?: number;
  hasBuild: boolean;
  hasTest: boolean;
  error?: string;
};

type ProjectPort = { port: number; address: string; process: string };

type ProgressAction =
  | 'refresh'
  | 'fetchAll'
  | 'syncAll'
  | 'commitAll'
  | 'pushAll'
  | 'syncRepo'
  | 'refreshProject'
  | 'loadModels'
  | 'fix';

type ProgressState = {
  active: boolean;
  action: ProgressAction | null;
  label: string;
  detail?: string;
  current?: number;
  total?: number;
  percent?: number;
  tone?: 'accent' | 'info' | 'ok' | 'warn' | 'bad';
};

function run(cwd: string, command: string, args: string[], timeout = 120000): Promise<string> {
  if (command === 'git') {
    return execGit(args, { cwd, timeoutMs: timeout });
  }
  return execFileAsync(command, args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  }).then(r => r.stdout);
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
  const result: RepoHealth = {
    ...repo,
    ahead: repo.ahead ?? 0,
    behind: repo.behind ?? 0,
    changes: repo.changes ?? 0,
    hasUpstream: repo.hasUpstream ?? false,
    missingReadme: true,
    missingLicense: true,
    hasBuild: false,
    hasTest: false
  };
  try {
    const files = await fs.promises.readdir(repo.path);
    result.missingReadme = !files.some(f => /^readme(?:\.|$)/i.test(f));
    result.missingLicense = !files.some(f => /^licen[cs]e(?:\.|$)/i.test(f));
    if (files.includes('package.json')) {
      const pkg = JSON.parse(await fs.promises.readFile(path.join(repo.path, 'package.json'), 'utf8'));
      result.hasBuild = typeof pkg.scripts?.build === 'string';
      result.hasTest = typeof pkg.scripts?.test === 'string';
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  return result;
}

function repoPriorityScore(r: RepoHealth): number {
  let score = 0;
  if (r.behind > 0 && r.ahead > 0) score += 1000;
  if (r.behind > 0) score += 500 + r.behind * 10;
  if (r.changes > 0) score += 250 + r.changes * 5;
  if (r.ahead > 0) score += 150 + r.ahead * 10;
  if (r.error) score += 100;
  if (r.missingReadme) score += 5;
  if (r.missingLicense) score += 5;
  if (r.outdated) score += 2;
  return score;
}

export class RepoCommandCenter {
  private panel?: vscode.WebviewPanel;
  private repos: RepoHealth[] = [];
  private projectTasks: string[] = [];
  private projectErrors: { file: string; line: number; message: string }[] = [];
  private projectPorts: ProjectPort[] = [];
  private busy = false;
  private pendingRefresh = false;
  private fetchingRemotes = false;
  private batchActionInFlight: ProgressAction | null = null;
  private syncingPaths = new Set<string>();
  private activePathLabels = new Map<string, string>();
  private progress: ProgressState | null = null;
  private progressClearTimer?: ReturnType<typeof setTimeout>;
  private lastCheckedAt?: string;
  private lastCheckedMs = 0;
  private lastFetchedAt?: string;
  private ollamaKeyConfigured = false;
  private onReposUpdated?: (repos: GitRepository[]) => void;

  constructor(
    private context: vscode.ExtensionContext,
    private scanner: RepoScanner,
    onReposUpdated?: (repos: GitRepository[]) => void
  ) {
    this.onReposUpdated = onReposUpdated;
  }

  public setOnReposUpdated(cb: (repos: GitRepository[]) => void) {
    this.onReposUpdated = cb;
  }

  public async syncFromExternalRepos(repos: GitRepository[]) {
    if (!this.panel || this.busy) return;
    const inspected = await mapWithConcurrency(
      repos.filter(r => r.syncStatus !== 'none'),
      8,
      inspect
    );
    this.repos = inspected.sort((a, b) => repoPriorityScore(b) - repoPriorityScore(a) || a.name.localeCompare(b.name));
    this.lastCheckedMs = Date.now();
    this.lastCheckedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.postState();
  }

  open() {
    if (this.panel) {
      this.panel.reveal();
      void this.refresh();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'repoCommandCenter',
      'Command Center',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'icon.png');
    this.panel.onDidDispose(() => {
      if (this.progressClearTimer) {
        clearTimeout(this.progressClearTimer);
        this.progressClearTimer = undefined;
      }
      this.panel = undefined;
    });
    this.panel.onDidChangeViewState(e => {
      if (e.webviewPanel.visible && Date.now() - this.lastCheckedMs > 10000) {
        void this.refresh();
      }
    });

    this.panel.webview.html = this.buildShellHtml();

    void this.context.secrets.get('smartCommit.ollamaApiKey').then(key => {
      this.ollamaKeyConfigured = !!key;
      this.postState();
    });

    this.panel.webview.onDidReceiveMessage(async m => {
      try {
        if (m.command === 'ready') {
          this.postState();
          void this.loadOllamaModels(true);
          return;
        }
        if (m.command === 'refresh') await this.refresh();
        if (m.command === 'fetchAll') await this.fetchAllRemotes();
        if (m.command === 'syncAll') await this.syncAllReady();
        if (m.command === 'open' && typeof m.path === 'string') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(m.path), { forceNewWindow: true });
        }
        if (m.command === 'openTerminal' && typeof m.path === 'string') {
          vscode.window.createTerminal({ name: path.basename(m.path), cwd: m.path }).show();
        }
        if (m.command === 'run' && typeof m.path === 'string' && (m.script === 'build' || m.script === 'test')) {
          await this.runScript(m.path, m.script);
        }
        if (m.command === 'fix' && typeof m.path === 'string') {
          const fixName = m.issue === 'readme' ? 'README' : 'License';
          const repoName = path.basename(m.path);
          this.syncingPaths.add(m.path);
          this.activePathLabels.set(m.path, `Adding ${fixName}…`);
          this.setProgress({
            action: 'fix',
            label: `Adding ${fixName}…`,
            detail: repoName
          });
          this.postState();
          try {
            await vscode.commands.executeCommand(
              m.issue === 'readme' ? 'git-management.generateReadme' : 'git-management.addLicense',
              vscode.Uri.file(m.path)
            );
            this.setProgress({
              action: 'fix',
              label: `Refreshing repositories…`,
              detail: repoName,
              percent: 90
            });
            await this.refresh(true);
            this.completeProgress('fix', `Updated ${fixName} for ${repoName}`, 'ok');
          } catch (fixErr) {
            this.completeProgress('fix', `Failed to add ${fixName}`, 'bad', errorText(fixErr));
            throw fixErr;
          } finally {
            this.syncingPaths.delete(m.path);
            this.activePathLabels.delete(m.path);
            this.postState();
          }
        }
        if (m.command === 'commitAll') await this.commitAll();
        if (m.command === 'pushAll') await this.pushAll();
        if (m.command === 'syncRepo' && typeof m.path === 'string') await this.syncByPath(m.path);
        if (m.command === 'refreshProject') await this.refreshProject(true);
        if (m.command === 'updateStartupSetting') {
          const config = vscode.workspace.getConfiguration('gitRepoManager');
          await config.update('showCommandCenterOnStartup', !!m.value, vscode.ConfigurationTarget.Global);
          this.postState();
        }
        if (m.command === 'setOllamaApiKey') {
          const value = String(m.value || '').trim();
          if (value) await this.context.secrets.store('smartCommit.ollamaApiKey', value);
          else await this.context.secrets.delete('smartCommit.ollamaApiKey');
          this.ollamaKeyConfigured = !!value;
          this.postState();
          vscode.window.showInformationMessage(value ? 'API key saved securely.' : 'API key cleared.');
        }
        if (m.command === 'loadOllamaModels') {
          await this.loadOllamaModels(false, typeof m.url === 'string' ? m.url : undefined);
        }
        if (m.command === 'updateCommitSettings' && m.values) {
          const config = vscode.workspace.getConfiguration('smartCommit');
          for (const key of [
            'format',
            'emojiStyle',
            'includeScope',
            'includeBody',
            'autoStageIfNone',
            'fallbackToUnstaged',
            'ollamaUrl',
            'ollamaModel'
          ] as const) {
            if (Object.prototype.hasOwnProperty.call(m.values, key)) {
              await config.update(key, m.values[key], vscode.ConfigurationTarget.Global);
            }
          }
          this.postState();
          vscode.window.showInformationMessage('Commit settings saved.');
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Command Center action failed: ${errorText(err)}`);
      }
    });

    void this.refresh();
  }

  private setProgress(state: Omit<ProgressState, 'active'>) {
    if (this.progressClearTimer) {
      clearTimeout(this.progressClearTimer);
      this.progressClearTimer = undefined;
    }
    this.progress = { active: true, tone: 'accent', ...state };
    this.panel?.webview.postMessage({ command: 'progress', payload: this.progress });
  }

  private completeProgress(action: ProgressAction, label: string, tone: 'ok' | 'warn' | 'bad' = 'ok', detail?: string) {
    if (this.progressClearTimer) {
      clearTimeout(this.progressClearTimer);
      this.progressClearTimer = undefined;
    }
    this.progress = { active: false, action, label, detail, percent: 100, tone };
    this.panel?.webview.postMessage({ command: 'progress', payload: this.progress });
    this.progressClearTimer = setTimeout(() => {
      this.progressClearTimer = undefined;
      if (this.progress && !this.progress.active) {
        this.progress = null;
        this.panel?.webview.postMessage({ command: 'progress', payload: null });
      }
    }, 2400);
  }

  private async loadOllamaModels(silent: boolean, overrideUrl?: string) {
    const config = vscode.workspace.getConfiguration('smartCommit');
    const rawUrl = overrideUrl !== undefined ? overrideUrl : (config.get<string>('ollamaUrl', '') || '');
    const baseUrl = rawUrl.trim().replace(/\/+$/, '');
    const selectedModel = (config.get<string>('ollamaModel', '') || '').trim();
    if (!baseUrl) {
      this.panel?.webview.postMessage({
        command: 'ollamaModels',
        models: [],
        selectedModel,
        error: 'No Inference API URL configured yet. Set one above or leave blank to use the built-in generator.'
      });
      return;
    }
    const apiBase = baseUrl.endsWith('/v1') ? baseUrl : baseUrl + '/v1';
    if (!silent) {
      this.setProgress({ action: 'loadModels', label: 'Loading AI models…', detail: apiBase + '/models' });
    }
    const key = await this.context.secrets.get('smartCommit.ollamaApiKey');
    try {
      const response = await fetch(apiBase + '/models', {
        headers: key ? { Authorization: 'Bearer ' + key } : {}
      });
      if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (await response.text()).slice(0, 300));
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      const models = [...new Set((data.data || []).map(model => model.id?.trim()).filter((id): id is string => !!id))]
        .sort()
        .map(name => ({ name }));
      if (!models.length) throw new Error('The inference endpoint returned no available models.');
      this.panel?.webview.postMessage({ command: 'ollamaModels', models, selectedModel });
      if (!silent) {
        this.completeProgress('loadModels', `Loaded ${models.length} model(s)`, 'ok');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.panel?.webview.postMessage({ command: 'ollamaModels', models: [], selectedModel, error: message });
      if (!silent) {
        this.completeProgress('loadModels', 'Failed to load models', 'bad', message);
        vscode.window.showErrorMessage('Could not load models: ' + message);
      }
    }
  }

  private postState() {
    if (!this.panel) return;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    const showOnStartup = vscode.workspace.getConfiguration('gitRepoManager').get<boolean>('showCommandCenterOnStartup', false);
    const commitConfig = vscode.workspace.getConfiguration('smartCommit');
    const normWs = workspace ? path.resolve(workspace.uri.fsPath).toLowerCase() : '';
    const currentRepoPath = normWs
      ? this.repos.find(r => path.resolve(r.path).toLowerCase() === normWs)?.path
      : undefined;

    this.panel.webview.postMessage({
      command: 'state',
      payload: {
        busy: this.busy,
        fetchingRemotes: this.fetchingRemotes,
        batchAction: this.batchActionInFlight,
        syncingPaths: Array.from(this.syncingPaths),
        activePathLabels: Object.fromEntries(this.activePathLabels),
        progress: this.progress,
        lastCheckedAt: this.lastCheckedAt || null,
        lastFetchedAt: this.lastFetchedAt || null,
        showOnStartup,
        currentRepoPath: currentRepoPath || null,
        repos: this.repos,
        workspace: workspace ? { name: workspace.name, path: workspace.uri.fsPath } : null,
        projectTasks: this.projectTasks,
        projectErrors: this.projectErrors,
        projectPorts: this.projectPorts,
        commitSettings: {
          format: commitConfig.get<string>('format', 'conventional'),
          emojiStyle: commitConfig.get<string>('emojiStyle', 'gitmoji'),
          includeScope: commitConfig.get<boolean>('includeScope', true),
          includeBody: commitConfig.get<boolean>('includeBody', false),
          autoStageIfNone: commitConfig.get<boolean>('autoStageIfNone', false),
          fallbackToUnstaged: commitConfig.get<boolean>('fallbackToUnstaged', true),
          ollamaUrl: (commitConfig.get<string>('ollamaUrl', '') || '').trim(),
          ollamaModel: (commitConfig.get<string>('ollamaModel', '') || '').trim(),
          ollamaKeyConfigured: this.ollamaKeyConfigured
        }
      }
    });
  }

  public async refresh(silentProgress = false) {
    if (!this.panel) return;
    if (this.busy) {
      this.pendingRefresh = true;
      return;
    }
    this.busy = true;
    this.pendingRefresh = false;
    if (!silentProgress) {
      this.setProgress({ action: 'refresh', label: 'Scanning repositories…', detail: 'Discovering Git repositories' });
    }
    this.postState();
    try {
      const projectPromise = this.refreshProject(false).catch(() => {});
      const repos = await this.scanner.scanRepositories();
      this.onReposUpdated?.(repos);
      const gitRepos = repos.filter(r => r.syncStatus !== 'none');
      let inspectedCount = 0;
      const total = gitRepos.length;
      if (!silentProgress && total > 0) {
        this.setProgress({
          action: 'refresh',
          label: `Inspecting repositories (0/${total})`,
          current: 0,
          total,
          percent: 10
        });
      }
      const inspected = await mapWithConcurrency(
        gitRepos,
        8,
        async repo => {
          const result = await inspect(repo);
          inspectedCount++;
          if (!silentProgress && total > 0) {
            this.setProgress({
              action: 'refresh',
              label: `Inspecting repositories (${inspectedCount}/${total})`,
              detail: repo.name,
              current: inspectedCount,
              total,
              percent: Math.min(96, 10 + Math.round((inspectedCount / total) * 86))
            });
          }
          return result;
        }
      );
      this.repos = inspected.sort((a, b) => repoPriorityScore(b) - repoPriorityScore(a) || a.name.localeCompare(b.name));
      this.lastCheckedMs = Date.now();
      this.lastCheckedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this.postState();
      await projectPromise;
      if (!silentProgress) {
        this.completeProgress('refresh', `Scanned ${this.repos.length} repositories`, 'ok');
      }
    } catch (err) {
      if (!silentProgress) {
        this.completeProgress('refresh', 'Repository scan failed', 'bad', errorText(err));
      }
      vscode.window.showErrorMessage(`Command Center refresh failed: ${errorText(err)}`);
    } finally {
      this.busy = false;
      this.postState();
      if (this.pendingRefresh && this.panel) {
        this.pendingRefresh = false;
        void this.refresh(silentProgress);
      }
    }
  }

  private async fetchAllRemotes() {
    if (!this.panel || this.fetchingRemotes || this.busy || this.batchActionInFlight) return;
    this.fetchingRemotes = true;
    this.setProgress({ action: 'fetchAll', label: 'Checking remotes…', detail: 'Preparing fetch' });
    this.postState();
    try {
      const sourceRepos = this.repos.length > 0 ? this.repos : await this.scanner.scanRepositories();
      const { fetched, failed } = await this.scanner.fetchAllRepositories(sourceRepos, (done, total, repoName) => {
        if (total <= 0) return;
        this.setProgress({
          action: 'fetchAll',
          label: `Checking remotes (${done}/${total})`,
          detail: repoName || 'Fetching remotes…',
          current: done,
          total,
          percent: Math.min(90, Math.round((done / total) * 90))
        });
      });
      this.lastFetchedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this.setProgress({ action: 'fetchAll', label: 'Updating repository status…', percent: 95 });
      this.fetchingRemotes = false;
      await this.refresh(true);
      const behindCount = this.repos.filter(r => r.behind > 0).length;
      const aheadCount = this.repos.filter(r => r.ahead > 0).length;
      const summary =
        behindCount || aheadCount
          ? `Checked ${fetched} remote(s): ${behindCount} behind, ${aheadCount} ahead.${failed ? ` (${failed} failed)` : ''}`
          : `Checked ${fetched} remote(s): all tracked repositories are up to date.${failed ? ` (${failed} failed)` : ''}`;
      this.completeProgress('fetchAll', summary, failed ? 'warn' : 'ok');
      vscode.window.showInformationMessage(summary);
    } catch (err) {
      this.completeProgress('fetchAll', 'Failed to check remotes', 'bad', errorText(err));
      vscode.window.showErrorMessage(`Failed to check remotes: ${errorText(err)}`);
    } finally {
      this.fetchingRemotes = false;
      this.postState();
    }
  }

  private async syncAllReady() {
    if (this.batchActionInFlight) return;
    const targets = this.repos.filter(r => r.hasUpstream && (r.behind > 0 || r.ahead > 0) && !(r.behind > 0 && r.changes > 0));
    if (targets.length === 0) {
      vscode.window.showInformationMessage('No clean repositories are ready to sync. Commit uncommitted changes first if a repository is behind.');
      return;
    }
    this.batchActionInFlight = 'syncAll';
    const output = getGitActionsOutput();
    output.clear();
    output.appendLine(`Sync all ready repositories started at ${new Date().toLocaleString()}`);
    output.show(true);

    const synced: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const total = targets.length;

    try {
      for (let i = 0; i < total; i++) {
        const repo = targets[i];
        this.syncingPaths.add(repo.path);
        this.activePathLabels.set(repo.path, 'Syncing…');
        this.setProgress({
          action: 'syncAll',
          label: `Syncing repositories (${i + 1}/${total})`,
          detail: `${repo.name} — Fetching remote…`,
          current: i + 1,
          total,
          percent: Math.round(((i + 0.1) / total) * 92)
        });
        this.postState();
        try {
          const res = await this.syncSingleRepo(repo, output, (stage, fraction) => {
            this.setProgress({
              action: 'syncAll',
              label: `Syncing repositories (${i + 1}/${total})`,
              detail: `${repo.name} — ${stage}`,
              current: i + 1,
              total,
              percent: Math.round(((i + fraction) / total) * 92)
            });
          });
          if (res === 'synced') synced.push(repo.name);
          else skipped.push(repo.name);
        } catch (e) {
          const message = errorText(e);
          failed.push(`${repo.name}: ${message}`);
          output.appendLine(`Sync failed: ${message}`);
        } finally {
          this.syncingPaths.delete(repo.path);
          this.activePathLabels.delete(repo.path);
          this.postState();
        }
      }

      output.appendLine('\nSync all finished.');
      this.setProgress({ action: 'syncAll', label: 'Refreshing repository status…', percent: 96 });
      await this.refresh(true);
      const details = [
        ...(synced.length ? [`Synced ${synced.length}: ${synced.join(', ')}`] : []),
        ...(skipped.length ? [`Up to date / skipped: ${skipped.join(', ')}`] : []),
        ...failed.map(s => `Failed: ${s}`)
      ].join('\n');
      const shortSummary = failed.length
        ? `Synced ${synced.length} of ${total} (${failed.length} failed)`
        : `Synced ${synced.length} repositor${synced.length === 1 ? 'y' : 'ies'}`;
      this.completeProgress('syncAll', shortSummary, failed.length ? 'warn' : 'ok');
      if (failed.length) vscode.window.showWarningMessage(details || 'Sync completed with errors.');
      else vscode.window.showInformationMessage(details || 'All ready repositories synced.');
    } finally {
      this.batchActionInFlight = null;
      this.postState();
    }
  }

  private async refreshProject(showProgress = false) {
    if (showProgress) {
      this.setProgress({ action: 'refreshProject', label: 'Inspecting active workspace…', detail: 'Checking ports, tasks, and errors' });
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.projectTasks = [];
      this.projectErrors = [];
      this.projectPorts = [];
      this.postState();
      if (showProgress) this.completeProgress('refreshProject', 'No active workspace folder', 'ok');
      return;
    }
    const root = path.resolve(folder.uri.fsPath);
    this.projectTasks = vscode.tasks.taskExecutions
      .filter(execution => {
        const scope = execution.task.scope;
        return (
          scope === vscode.TaskScope.Global ||
          (typeof scope === 'object' && 'uri' in scope && path.resolve(scope.uri.fsPath) === root)
        );
      })
      .map(execution => execution.task.name);

    const errors: typeof this.projectErrors = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file' || !path.resolve(uri.fsPath).startsWith(root + path.sep)) continue;
      for (const d of diagnostics) {
        if (d.severity === vscode.DiagnosticSeverity.Error) {
          errors.push({ file: path.relative(root, uri.fsPath), line: d.range.start.line + 1, message: d.message });
        }
      }
    }
    this.projectErrors = errors.slice(-20).reverse();
    this.projectPorts = await findProjectPorts(root);
    this.postState();
    if (showProgress) {
      this.completeProgress('refreshProject', 'Workspace status updated', 'ok');
    }
  }

  private async commitAll() {
    if (this.batchActionInFlight) return;
    const targets = this.repos.filter(r => r.changes > 0);
    if (targets.length === 0) {
      vscode.window.showInformationMessage('No repositories have uncommitted changes.');
      return;
    }
    this.batchActionInFlight = 'commitAll';
    const output = getGitActionsOutput();
    output.appendLine(`\nCommit all changes started at ${new Date().toLocaleString()} (${targets.length} repo(s))`);

    const changed: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const total = targets.length;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'xVSGravityTools: Committing changes'
        },
        async (vsProgress) => {
          for (let i = 0; i < total; i++) {
            const repo = targets[i];
            const stepLabel = `Committing changes (${i + 1}/${total})`;
            this.syncingPaths.add(repo.path);
            this.activePathLabels.set(repo.path, 'Committing…');
            this.setProgress({
              action: 'commitAll',
              label: stepLabel,
              detail: `${repo.name} — Staging changes…`,
              current: i + 1,
              total,
              percent: Math.round(((i + 0.15) / total) * 92)
            });
            vsProgress.report({ message: `${i + 1}/${total} · ${repo.name} (staging)` });
            this.postState();
            try {
              const status = await run(repo.path, 'git', ['status', '--porcelain=v1']);
              if (!status.trim()) {
                skipped.push(repo.name);
                continue;
              }
              await run(repo.path, 'git', ['add', '-A']);
              const stagedDiff = await run(repo.path, 'git', ['diff', '--cached', '--no-ext-diff', '--binary']);
              const fileDiffs = DiffAnalyzer.parseDiff(stagedDiff);
              if (fileDiffs.length === 0) {
                skipped.push(`${repo.name} (no committable changes)`);
                continue;
              }
              this.setProgress({
                action: 'commitAll',
                label: stepLabel,
                detail: `${repo.name} — Generating commit message…`,
                current: i + 1,
                total,
                percent: Math.round(((i + 0.45) / total) * 92)
              });
              vsProgress.report({ message: `${i + 1}/${total} · ${repo.name} (generating message)` });
              const message = await generateCommitMessage(fileDiffs);
              this.setProgress({
                action: 'commitAll',
                label: stepLabel,
                detail: `${repo.name} — Committing…`,
                current: i + 1,
                total,
                percent: Math.round(((i + 0.8) / total) * 92)
              });
              vsProgress.report({ message: `${i + 1}/${total} · ${repo.name} (committing)` });
              await run(repo.path, 'git', ['commit', '-m', message]);
              changed.push(repo.name);
              output.appendLine(`[${repo.name}] Committed: ${message.split(/\r?\n/)[0]}`);
              this.setProgress({
                action: 'commitAll',
                label: stepLabel,
                detail: `${repo.name} — Committed`,
                current: i + 1,
                total,
                percent: Math.round(((i + 1) / total) * 92)
              });
            } catch (e) {
              const errMsg = errorText(e);
              failed.push(`${repo.name}: ${errMsg}`);
              output.appendLine(`[${repo.name}] Commit failed: ${errMsg}`);
            } finally {
              this.syncingPaths.delete(repo.path);
              this.activePathLabels.delete(repo.path);
              this.postState();
            }
          }
          this.setProgress({ action: 'commitAll', label: 'Refreshing repository status…', percent: 96 });
          vsProgress.report({ message: 'Refreshing repositories…' });
          await this.refresh(true);
        }
      );

      const details = [
        ...(changed.length ? [`Committed ${changed.length}: ${changed.join(', ')}`] : []),
        ...(skipped.length ? [`Already clean: ${skipped.join(', ')}`] : []),
        ...failed.map(s => `Failed: ${s}`)
      ].join('\n');
      const shortSummary = failed.length
        ? `Committed ${changed.length} of ${total} (${failed.length} failed)`
        : `Committed ${changed.length} repositor${changed.length === 1 ? 'y' : 'ies'}`;
      this.completeProgress('commitAll', shortSummary, failed.length ? 'warn' : 'ok');
      if (failed.length) vscode.window.showWarningMessage(details || 'No repositories had changes to commit.');
      else vscode.window.showInformationMessage(details || 'All changed repositories committed successfully.');
    } finally {
      this.batchActionInFlight = null;
      this.postState();
    }
  }

  private async pushAll() {
    if (this.batchActionInFlight) return;
    const targets = this.repos.filter(r => r.hasUpstream && r.ahead > 0 && r.behind === 0);
    if (targets.length === 0) {
      vscode.window.showInformationMessage('No repositories have outgoing commits ready to push.');
      return;
    }
    this.batchActionInFlight = 'pushAll';
    const pushed: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const total = targets.length;
    const output = getGitActionsOutput();
    output.clear();
    output.appendLine(`Push outgoing commits started at ${new Date().toLocaleString()}`);
    output.show(true);

    try {
      for (let i = 0; i < total; i++) {
        const repo = targets[i];
        const stepLabel = `Pushing commits (${i + 1}/${total})`;
        this.syncingPaths.add(repo.path);
        this.activePathLabels.set(repo.path, 'Pushing…');
        this.setProgress({
          action: 'pushAll',
          label: stepLabel,
          detail: `${repo.name} — Checking upstream status…`,
          current: i + 1,
          total,
          percent: Math.round(((i + 0.2) / total) * 92)
        });
        this.postState();
        output.appendLine(`\n[${repo.name}] Checking upstream status...`);
        try {
          const status = await run(repo.path, 'git', ['status', '--porcelain=v1', '-b']);
          const lines = status.split(/\r?\n/).filter(Boolean);
          const header = lines[0] || '';
          const aheadMatch = header.match(/ahead (\d+)/);
          const behindMatch = header.match(/behind (\d+)/);
          const ahead = Number(aheadMatch?.[1] || 0);
          const behind = Number(behindMatch?.[1] || 0);
          if (!header.includes('...') || ahead < 1 || behind > 0) {
            skipped.push(repo.name);
            output.appendLine(`Skipped: no safe outgoing commits (ahead ${ahead}, behind ${behind}).`);
            continue;
          }
          this.setProgress({
            action: 'pushAll',
            label: stepLabel,
            detail: `${repo.name} — Pushing ${ahead} commit(s)…`,
            current: i + 1,
            total,
            percent: Math.round(((i + 0.55) / total) * 92)
          });
          output.appendLine(`Pushing ${ahead} outgoing commit(s)...`);
          output.appendLine(`> git push --progress`);
          await runGitWithOutput(repo.path, ['push', '--progress'], output);
          pushed.push(repo.name);
          output.appendLine('Push completed successfully.');
          this.setProgress({
            action: 'pushAll',
            label: stepLabel,
            detail: `${repo.name} — Pushed`,
            current: i + 1,
            total,
            percent: Math.round(((i + 1) / total) * 92)
          });
        } catch (e) {
          const message = errorText(e);
          failed.push(`${repo.name}: ${message}`);
          output.appendLine(`Push failed: ${message}`);
        } finally {
          this.syncingPaths.delete(repo.path);
          this.activePathLabels.delete(repo.path);
          this.postState();
        }
      }
      output.appendLine('\nPush action finished.');
      this.setProgress({ action: 'pushAll', label: 'Refreshing repository status…', percent: 96 });
      await this.refresh(true);
      const details = [
        ...(pushed.length ? [`Pushed ${pushed.length}: ${pushed.join(', ')}`] : []),
        ...(skipped.length ? [`No safe outgoing commits: ${skipped.join(', ')}`] : []),
        ...failed.map(s => `Failed: ${s}`)
      ].join('\n');
      const shortSummary = failed.length
        ? `Pushed ${pushed.length} of ${total} (${failed.length} failed)`
        : `Pushed ${pushed.length} repositor${pushed.length === 1 ? 'y' : 'ies'}`;
      this.completeProgress('pushAll', shortSummary, failed.length ? 'warn' : 'ok');
      if (failed.length) vscode.window.showWarningMessage(details || 'No repositories had outgoing commits to push.');
      else vscode.window.showInformationMessage(details || 'Ready repositories pushed successfully.');
    } finally {
      this.batchActionInFlight = null;
      this.postState();
    }
  }

  public async syncSingleRepo(
    repo: { name: string; path: string },
    output: vscode.OutputChannel,
    onStage?: (stage: string, fraction: number) => void
  ): Promise<'synced' | 'skipped' | 'up-to-date'> {
    output.appendLine(`\n[${repo.name}] Fetching remote status...`);
    onStage?.('Fetching remote…', 0.2);
    try {
      await run(repo.path, 'git', ['fetch', '--prune'], 30000);
    } catch (e) {
      output.appendLine(`Fetch note: ${errorText(e)}`);
    }

    onStage?.('Checking status…', 0.35);
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
      onStage?.('Up to date', 1);
      return 'up-to-date';
    }

    if (behind > 0 && hasChanges) {
      output.appendLine(`Cannot pull safely: repository has uncommitted changes. Commit or stash them first.`);
      throw new Error(`Repository has uncommitted changes and cannot pull incoming commits.`);
    }

    let pulled = false;
    let pushed = false;
    if (behind > 0) {
      onStage?.(`Pulling ${behind} commit(s)…`, 0.55);
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
      onStage?.(`Pushing ${ahead} commit(s)…`, 0.8);
      output.appendLine(`Pushing ${ahead} outgoing commit(s)...`);
      output.appendLine(`> git push --progress`);
      await runGitWithOutput(repo.path, ['push', '--progress'], output);
      output.appendLine(`Push completed.`);
      pushed = true;
    }

    if (!pulled && !pushed) {
      output.appendLine(`Already up to date.`);
      onStage?.('Up to date', 1);
      return 'up-to-date';
    }

    output.appendLine(`Sync finished successfully.`);
    onStage?.('Synced', 1);
    return 'synced';
  }

  public async syncByPath(repoPath: string) {
    const name = path.basename(repoPath);
    const repo = this.repos.find(r => path.resolve(r.path) === path.resolve(repoPath)) || { name, path: repoPath };
    const output = getGitActionsOutput();
    output.clear();
    output.appendLine(`Sync started for [${name}] at ${new Date().toLocaleString()}`);
    output.show(true);
    this.syncingPaths.add(repo.path);
    this.activePathLabels.set(repo.path, 'Syncing…');
    this.setProgress({ action: 'syncRepo', label: `Syncing ${name}`, detail: 'Fetching remote…', percent: 15 });
    this.postState();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `xVSGravityTools: Syncing ${name}`
        },
        async (vsProgress) => {
          const res = await this.syncSingleRepo(repo, output, (stage, fraction) => {
            this.setProgress({
              action: 'syncRepo',
              label: `Syncing ${name}`,
              detail: stage,
              percent: Math.round(fraction * 90)
            });
            vsProgress.report({ message: stage });
          });
          if (this.panel) {
            this.setProgress({ action: 'syncRepo', label: `Syncing ${name}`, detail: 'Refreshing status…', percent: 95 });
            await this.refresh(true);
          }
          if (res === 'synced') {
            this.completeProgress('syncRepo', `[${name}] Synced`, 'ok');
            vscode.window.showInformationMessage(`[${name}] Synced successfully.`);
          } else if (res === 'up-to-date') {
            this.completeProgress('syncRepo', `[${name}] Already up to date`, 'ok');
            vscode.window.showInformationMessage(`[${name}] Already up to date.`);
          } else {
            this.completeProgress('syncRepo', `[${name}] No upstream branch`, 'warn');
            vscode.window.showInformationMessage(`[${name}] Skipped: No remote upstream branch tracked.`);
          }
        }
      );
    } catch (e) {
      const message = errorText(e);
      output.appendLine(`Sync failed: ${message}`);
      this.completeProgress('syncRepo', `[${name}] Sync failed`, 'bad', message);
      vscode.window.showErrorMessage(`[${name}] Sync failed: ${message}`);
      if (this.panel) await this.refresh(true);
    } finally {
      this.syncingPaths.delete(repo.path);
      this.activePathLabels.delete(repo.path);
      this.postState();
    }
  }

  private async runScript(repoPath: string, script: 'build' | 'test') {
    const name = path.basename(repoPath);
    try {
      const pkg = JSON.parse(await fs.promises.readFile(path.join(repoPath, 'package.json'), 'utf8'));
      if (!pkg.scripts?.[script]) {
        vscode.window.showInformationMessage(`${name} has no ${script} script.`);
        return;
      }
      const terminal = vscode.window.createTerminal({ name: `${name}: ${script}`, cwd: repoPath });
      terminal.show();
      terminal.sendText(`npm run ${script}`);
    } catch {
      vscode.window.showInformationMessage('Build and test buttons currently support npm projects with a package.json.');
    }
  }

  private buildShellHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Command Center</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --surface: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
    --surface-2: var(--vscode-editorWidget-background, var(--surface));
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground, color-mix(in oklab, var(--fg) 68%, transparent));
    --border: var(--vscode-contrastBorder, var(--vscode-panel-border, color-mix(in oklab, var(--fg) 14%, transparent)));
    --border-strong: var(--vscode-contrastBorder, color-mix(in oklab, var(--fg) 22%, transparent));
    --accent: var(--vscode-focusBorder, var(--vscode-button-background, #3794ff));
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #ffffff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
    --btn2-bg: var(--vscode-button-secondaryBackground, color-mix(in oklab, var(--fg) 10%, transparent));
    --btn2-fg: var(--vscode-button-secondaryForeground, var(--fg));
    --btn2-hover: var(--vscode-button-secondaryHoverBackground, color-mix(in oklab, var(--fg) 16%, transparent));
    --ok: var(--vscode-charts-green, #4ec98a);
    --warn: var(--vscode-charts-yellow, #e5bd59);
    --bad: var(--vscode-charts-red, #f27676);
    --info: var(--vscode-charts-blue, #70adff);
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 14px;
    accent-color: var(--accent);
  }

  * { box-sizing: border-box; }

  body.vscode-dark, body.vscode-high-contrast {
    color-scheme: dark;
  }
  body.vscode-light, body.vscode-high-contrast-light {
    color-scheme: light;
  }

  ::selection {
    background: var(--vscode-editor-selectionBackground);
  }

  body {
    margin: 0;
    padding: clamp(14px, 2.2vw, 28px);
    padding-bottom: 52px;
    font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
    font-size: 13px;
    line-height: 1.45;
    color: var(--fg);
    background: var(--bg);
  }

  /* Window-edge thin progress bars (top + bottom dock) */
  .win-progress {
    pointer-events: none;
    line-height: 0;
  }
  .win-progress.top {
    position: fixed;
    inset: 0 0 auto 0;
    z-index: 200;
    height: 3px;
  }
  .win-progress.bottom {
    width: 100%;
    height: 2px;
  }
  .win-progress progress {
    appearance: none;
    border: 0 solid;
    overflow: clip;
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 0;
    background: color-mix(in oklab, var(--fg) 10%, transparent);
    container-type: inline-size;
    --progress-bar-fill: var(--accent);
    --progress-bar-indeterminate-size: 32%;
    --progress-bar-indeterminate-animation-duration: 1.35s;
  }
  .win-progress[data-tone="ok"] progress { --progress-bar-fill: var(--ok); }
  .win-progress[data-tone="warn"] progress { --progress-bar-fill: var(--warn); }
  .win-progress[data-tone="bad"] progress { --progress-bar-fill: var(--bad); }
  .win-progress progress:dir(rtl) {
    --progress-bar-indeterminate-animation: progress-bar-indeterminate var(--progress-bar-indeterminate-animation-duration) infinite linear reverse;
  }
  .win-progress progress:indeterminate {
    --progress-bar-animation: var(
      --progress-bar-indeterminate-animation,
      progress-bar-indeterminate var(--progress-bar-indeterminate-animation-duration) infinite linear
    );
  }
  .win-progress progress::-webkit-progress-bar {
    background: transparent;
  }
  .win-progress progress::-webkit-progress-value {
    background: var(--progress-bar-fill);
    transition: inline-size 220ms ease;
    animation: var(--progress-bar-animation, revert-rule);
  }
  .win-progress progress::-moz-progress-bar {
    background: var(--progress-bar-fill);
    transition: inline-size 220ms ease;
    animation: var(--progress-bar-animation, revert-rule);
  }
  @keyframes progress-bar-indeterminate {
    from, to {
      inline-size: var(--progress-bar-indeterminate-size);
      margin-right: auto;
    }
    from { translate: -100%; }
    to { translate: 100cqi; }
  }
  @media (prefers-reduced-motion: reduce) {
    .win-progress progress {
      --progress-bar-indeterminate-animation-duration: 10s;
    }
  }

  .bottom-progress-dock {
    position: fixed;
    inset: auto 0 0 0;
    z-index: 200;
    background: color-mix(in oklab, var(--surface) 94%, var(--bg));
    border-top: 1px solid var(--border-strong);
    backdrop-filter: blur(8px);
    box-shadow: 0 -4px 16px rgb(0 0 0 / 0.18);
  }
  .bottom-progress-dock[hidden],
  .win-progress[hidden] {
    display: none;
  }
  .progress-dock-inner {
    max-width: 1440px;
    margin: 0 auto;
    padding: 7px clamp(14px, 2.2vw, 28px);
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    min-height: 32px;
  }
  .progress-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    flex: 0 0 auto;
    background: var(--accent);
  }
  .bottom-progress-dock[data-tone="ok"] .progress-dot { background: var(--ok); }
  .bottom-progress-dock[data-tone="warn"] .progress-dot { background: var(--warn); }
  .bottom-progress-dock[data-tone="bad"] .progress-dot { background: var(--bad); }
  .bottom-progress-dock[data-active="true"] .progress-dot {
    animation: pulse-dot 1.2s ease-in-out infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.82); }
  }
  @media (prefers-reduced-motion: reduce) {
    .bottom-progress-dock[data-active="true"] .progress-dot { animation: none; }
  }
  .progress-label {
    font-weight: 600;
    color: var(--fg);
    white-space: nowrap;
  }
  .progress-detail {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .progress-meta {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    white-space: nowrap;
  }
  article.repo-card[data-busy="true"] {
    border-color: color-mix(in oklab, var(--accent) 65%, var(--border));
  }

  .app {
    max-width: 1440px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* Top bar */
  .topbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px 20px;
  }
  .brand {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .brand h1 {
    margin: 0;
    font-size: clamp(20px, 2.4vw, 26px);
    font-weight: 650;
    letter-spacing: -0.02em;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .brand-meta {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .topbar-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  /* Buttons */
  button {
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.2;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    padding: 7px 12px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--btn2-bg);
    color: var(--btn2-fg);
    transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
    user-select: none;
  }
  button:hover:not(:disabled) {
    background: var(--btn2-hover);
    border-color: var(--border-strong);
  }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  button.primary {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border-color: transparent;
  }
  button.primary:hover:not(:disabled) {
    background: var(--btn-hover);
  }
  button.warn-btn {
    background: color-mix(in oklab, var(--warn) 18%, var(--surface));
    border-color: color-mix(in oklab, var(--warn) 48%, transparent);
    color: var(--fg);
  }
  button.warn-btn:hover:not(:disabled) {
    background: color-mix(in oklab, var(--warn) 28%, var(--surface));
  }
  button.sm {
    padding: 5px 9px;
    font-size: 12px;
  }
  button svg, .pill svg, .banner-icon svg {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
  }

  .startup-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    user-select: none;
  }
  .startup-toggle:hover { color: var(--fg); }

  /* Accessible Tablist */
  .tablist-wrap {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .tablist {
    display: flex;
    overflow-x: auto;
    gap: 4px;
    padding-bottom: 1px;
    scroll-snap-type: inline proximity;
  }
  .tablist [role="tab"] {
    position: relative;
    flex: none;
    scroll-snap-align: start;
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    padding: 10px 14px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 500;
  }
  .tablist [role="tab"]:hover {
    color: var(--fg);
    background: color-mix(in oklab, var(--fg) 5%, transparent);
  }
  .tablist [role="tab"][aria-selected="true"] {
    color: var(--fg);
  }
  .tablist [role="tab"][aria-selected="true"]::after {
    content: "";
    position: absolute;
    inset: auto 0 0 0;
    border-block-end: 2px solid var(--accent);
  }
  .tab-count {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--fg) 10%, transparent);
    color: var(--fg);
  }
  .tab-count.alert {
    background: color-mix(in oklab, var(--warn) 24%, transparent);
    border: 1px solid color-mix(in oklab, var(--warn) 50%, transparent);
  }

  /* Panels: normal block flow so hidden="until-found" collapses to 0px and never overlaps the active panel */
  .panels {
    display: block;
  }
  [role="tabpanel"][hidden] {
    pointer-events: none;
  }
  .panel-inner {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding-top: 4px;
  }

  /* Sync Hero Banner */
  .sync-banner {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 14px 20px;
    padding: 16px 18px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .sync-banner[data-level="ok"] {
    border-color: color-mix(in oklab, var(--ok) 40%, var(--border));
    background: color-mix(in oklab, var(--ok) 8%, var(--surface));
  }
  .sync-banner[data-level="info"] {
    border-color: color-mix(in oklab, var(--info) 45%, var(--border));
    background: color-mix(in oklab, var(--info) 9%, var(--surface));
  }
  .sync-banner[data-level="warn"] {
    border-color: color-mix(in oklab, var(--warn) 50%, var(--border));
    background: color-mix(in oklab, var(--warn) 10%, var(--surface));
  }
  .sync-banner[data-level="bad"] {
    border-color: color-mix(in oklab, var(--bad) 50%, var(--border));
    background: color-mix(in oklab, var(--bad) 10%, var(--surface));
  }
  .banner-left {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    min-width: 0;
  }
  .banner-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    border: 1px solid var(--border);
    background: var(--bg);
  }
  .banner-icon svg { width: 18px; height: 18px; }
  .sync-banner[data-level="ok"] .banner-icon { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 45%, transparent); }
  .sync-banner[data-level="info"] .banner-icon { color: var(--info); border-color: color-mix(in oklab, var(--info) 45%, transparent); }
  .sync-banner[data-level="warn"] .banner-icon { color: var(--warn); border-color: color-mix(in oklab, var(--warn) 50%, transparent); }
  .sync-banner[data-level="bad"] .banner-icon { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 50%, transparent); }
  .banner-title {
    margin: 0;
    font-size: 15px;
    font-weight: 650;
  }
  .banner-sub {
    margin: 3px 0 0;
    font-size: 12.5px;
    color: var(--muted);
  }
  .banner-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  /* KPI Strip */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
  }
  .kpi {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: pointer;
    text-align: left;
  }
  .kpi:hover {
    border-color: var(--border-strong);
    background: color-mix(in oklab, var(--fg) 4%, var(--surface));
  }
  .kpi-label {
    font-size: 11.5px;
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .kpi-val {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  .kpi[data-tone="bad"] .kpi-val { color: var(--bad); }
  .kpi[data-tone="warn"] .kpi-val { color: var(--warn); }
  .kpi[data-tone="info"] .kpi-val { color: var(--info); }
  .kpi[data-tone="ok"] .kpi-val { color: var(--ok); }

  /* Section headings */
  .section-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  .section-title {
    margin: 0;
    font-size: 15px;
    font-weight: 650;
  }
  .section-sub {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--muted);
  }

  /* Filter Toolbar */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .search-wrap {
    flex: 1 1 240px;
    max-width: 380px;
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-wrap input, .settings-card input[type="text"], .settings-card input[type="password"], .settings-card select, .toolbar select {
    width: 100%;
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--vscode-input-border, var(--border));
    background: var(--vscode-input-background, var(--bg));
    color: var(--vscode-input-foreground, var(--fg));
    font: inherit;
    font-size: 12.5px;
  }
  .settings-card select, .toolbar select {
    background: var(--vscode-dropdown-background, var(--vscode-input-background, var(--bg)));
    color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground, var(--fg)));
    border-color: var(--vscode-dropdown-border, var(--vscode-input-border, var(--border)));
  }
  input::placeholder, textarea::placeholder {
    color: var(--vscode-input-placeholderForeground, var(--muted));
  }
  .toolbar select { width: auto; min-width: 165px; }
  .filter-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .chip {
    padding: 5px 10px;
    border-radius: 999px;
    font-size: 12px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .chip:hover { color: var(--fg); }
  .chip[aria-pressed="true"] {
    background: color-mix(in oklab, var(--accent) 18%, var(--bg));
    border-color: var(--accent);
    color: var(--fg);
  }

  /* Repository Cards */
  .repo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
    gap: 12px;
  }
  article.repo-card {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 15px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    border-inline-start: 3px solid var(--border-strong);
    background: var(--surface);
    transition: border-color 120ms ease;
  }
  article.repo-card:hover {
    border-color: var(--border-strong);
  }
  article.repo-card[data-state="synced"] { border-inline-start-color: var(--ok); }
  article.repo-card[data-state="ahead"] { border-inline-start-color: var(--info); }
  article.repo-card[data-state="dirty"] { border-inline-start-color: var(--warn); }
  article.repo-card[data-state="behind"],
  article.repo-card[data-state="diverged"],
  article.repo-card[data-state="error"] { border-inline-start-color: var(--bad); }

  article.repo-card > header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
  }
  .repo-id {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .repo-name-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .repo-name {
    margin: 0;
    font-size: 14.5px;
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  .ws-tag {
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--accent) 20%, transparent);
    border: 1px solid color-mix(in oklab, var(--accent) 50%, transparent);
    color: var(--fg);
  }
  .repo-path {
    font-size: 11.5px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .repo-head-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .repo-signals {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 500;
    border: 1px solid var(--border);
    background: color-mix(in oklab, var(--fg) 4%, transparent);
  }
  .pill.ok {
    color: var(--ok);
    border-color: color-mix(in oklab, var(--ok) 42%, transparent);
    background: color-mix(in oklab, var(--ok) 10%, transparent);
  }
  .pill.warn {
    color: var(--warn);
    border-color: color-mix(in oklab, var(--warn) 45%, transparent);
    background: color-mix(in oklab, var(--warn) 11%, transparent);
  }
  .pill.bad {
    color: var(--bad);
    border-color: color-mix(in oklab, var(--bad) 45%, transparent);
    background: color-mix(in oklab, var(--bad) 11%, transparent);
  }
  .pill.info {
    color: var(--info);
    border-color: color-mix(in oklab, var(--info) 45%, transparent);
    background: color-mix(in oklab, var(--info) 11%, transparent);
  }
  .pill.muted { color: var(--muted); }

  article.repo-card > footer {
    margin-top: auto;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .branch-meta {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
    min-width: 0;
  }
  .branch-meta svg { width: 13px; height: 13px; flex: 0 0 auto; }
  .footer-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  @container (max-width: 310px) {
    article.repo-card > header { flex-direction: column; }
    .repo-head-actions { width: 100%; }
    .repo-head-actions button { flex: 1; }
  }

  /* Action cards */
  .action-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
    gap: 12px;
  }
  .action-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    padding: 15px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .action-card h3 { margin: 0; font-size: 14px; font-weight: 650; }
  .action-card p { margin: 0; font-size: 12.5px; color: var(--muted); flex: 1; }

  /* Settings */
  .settings-layout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
    gap: 16px;
  }
  .settings-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .settings-card h3 { margin: 0; font-size: 14.5px; font-weight: 650; }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12.5px;
  }
  .field-hint { font-size: 11.5px; color: var(--muted); }
  .check-list { display: flex; flex-direction: column; gap: 9px; }
  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .inline-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .status-box {
    font-size: 12px;
    color: var(--muted);
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg);
  }

  /* Diff viewer */
  .diff-inputs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  @media (max-width: 720px) {
    .diff-inputs { grid-template-columns: 1fr; }
  }
  .diff-pane { display: flex; flex-direction: column; gap: 6px; }
  .diff-pane label { font-weight: 600; font-size: 12.5px; }
  .diff-pane textarea {
    width: 100%;
    height: 240px;
    resize: vertical;
    padding: 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--vscode-input-border, var(--border));
    background: var(--vscode-input-background, var(--surface));
    color: var(--vscode-input-foreground, var(--fg));
    font: 12.5px/1.45 var(--vscode-editor-font-family, monospace);
    tab-size: 4;
  }
  .diff-output {
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    font: 12.5px/1.5 var(--vscode-editor-font-family, monospace);
  }
  .diff-row { display: flex; white-space: pre; min-height: 21px; }
  .diff-row .ln {
    flex: 0 0 42px;
    text-align: right;
    padding: 1px 7px;
    color: var(--muted);
    user-select: none;
    border-right: 1px solid var(--border);
  }
  .diff-row .mk { flex: 0 0 22px; text-align: center; user-select: none; }
  .diff-row .cd { padding: 1px 10px; min-width: 0; }
  .diff-row.add { background: color-mix(in oklab, var(--ok) 16%, transparent); }
  .diff-row.remove { background: color-mix(in oklab, var(--bad) 16%, transparent); }
  .diff-row.add .mk { color: var(--ok); }
  .diff-row.remove .mk { color: var(--bad); }

  .empty-state {
    padding: 28px 18px;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--muted);
  }

  .spin {
    animation: spin 900ms linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin { animation: none; }
  }
  @media (forced-colors: active) {
    article.repo-card, .sync-banner, .kpi, .pill, button {
      border-color: CanvasText;
    }
    .tablist [role="tab"][aria-selected="true"]::after {
      border-block-end-color: Highlight;
    }
    .win-progress progress {
      forced-color-adjust: none;
      background: Canvas;
      --progress-bar-fill: Highlight;
    }
  }
</style>
</head>
<body>
<div class="win-progress top" id="topProgressWrap" hidden>
  <progress id="topProgress" max="100" aria-label="Operation progress"></progress>
</div>
<div class="app">
  <header class="topbar">
    <div class="brand">
      <h1>Command Center</h1>
      <div class="brand-meta" id="brandMeta">Scanning repositories…</div>
    </div>
    <div class="topbar-actions">
      <label class="startup-toggle">
        <input id="startupCheck" type="checkbox">
        Open on startup
      </label>
      <button type="button" id="fetchAllBtn" title="Run git fetch --prune across tracked repositories to detect incoming remote commits">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 2v8m0 0-3-3m3 3 3-3M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1"/></svg>
        <span id="fetchAllLabel">Check Remotes</span>
      </button>
      <button type="button" id="refreshBtn" class="primary">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.7M13.5 2.5v3h-3"/></svg>
        <span id="refreshLabel">Refresh</span>
      </button>
    </div>
  </header>

  <div class="tablist-wrap">
    <div class="tablist" role="tablist" aria-label="Command Center sections">
      <button type="button" role="tab" id="tab-overview" data-panel="panel-overview" aria-selected="true">
        Overview <span class="tab-count" id="count-attention">0</span>
      </button>
      <button type="button" role="tab" id="tab-repos" data-panel="panel-repos" aria-selected="false" tabindex="-1">
        Repositories <span class="tab-count" id="count-repos">0</span>
      </button>
      <button type="button" role="tab" id="tab-tools" data-panel="panel-tools" aria-selected="false" tabindex="-1">
        Build &amp; Test <span class="tab-count" id="count-tools">0</span>
      </button>
      <button type="button" role="tab" id="tab-project" data-panel="panel-project" aria-selected="false" tabindex="-1">
        Project <span class="tab-count" id="count-project">0</span>
      </button>
      <button type="button" role="tab" id="tab-diff" data-panel="panel-diff" aria-selected="false" tabindex="-1">
        Diff Viewer
      </button>
      <button type="button" role="tab" id="tab-settings" data-panel="panel-settings" aria-selected="false" tabindex="-1">
        Settings
      </button>
    </div>
  </div>

  <main class="panels">
    <section role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
      <div class="panel-inner">
        <div id="syncBanner"></div>
        <div id="currentWorkspaceSection"></div>
        <div class="kpi-grid" id="kpiGrid"></div>
        <div class="section-head">
          <div>
            <h2 class="section-title">Needs sync &amp; attention</h2>
            <p class="section-sub">Repositories with incoming commits, outgoing commits, uncommitted changes, or setup issues.</p>
          </div>
          <button type="button" class="sm" id="viewAllReposBtn">Browse all repositories</button>
        </div>
        <div class="repo-grid" id="attentionGrid"></div>
        <div class="section-head">
          <div>
            <h2 class="section-title">Batch Git actions</h2>
            <p class="section-sub">Only repositories that require action are touched.</p>
          </div>
        </div>
        <div class="action-grid" id="batchActions"></div>
      </div>
    </section>

    <section role="tabpanel" id="panel-repos" aria-labelledby="tab-repos" hidden="until-found">
      <div class="panel-inner">
        <div class="toolbar">
          <div class="search-wrap">
            <input id="repoSearch" type="search" placeholder="Filter by repository name, branch, or path…" aria-label="Filter repositories">
          </div>
          <div class="filter-pills" id="filterPills"></div>
          <select id="repoSort" aria-label="Sort repositories">
            <option value="priority">Sort: Needs Sync First</option>
            <option value="name">Sort: Name (A–Z)</option>
            <option value="changes">Sort: Most Changes</option>
            <option value="commits">Sort: Most Incoming/Outgoing</option>
          </select>
        </div>
        <div class="repo-grid" id="allReposGrid"></div>
      </div>
    </section>

    <section role="tabpanel" id="panel-tools" aria-labelledby="tab-tools" hidden="until-found">
      <div class="panel-inner">
        <div class="section-head">
          <div>
            <h2 class="section-title">Build &amp; test runners</h2>
            <p class="section-sub">Launch npm build or test scripts in a dedicated integrated terminal.</p>
          </div>
        </div>
        <div class="repo-grid" id="toolsGrid"></div>
      </div>
    </section>

    <section role="tabpanel" id="panel-project" aria-labelledby="tab-project" hidden="until-found">
      <div class="panel-inner">
        <div class="section-head">
          <div>
            <h2 class="section-title">Active workspace status</h2>
            <p class="section-sub" id="projectPathLabel">Open a project folder to inspect ports, tasks, and errors.</p>
          </div>
          <button type="button" class="sm" id="refreshProjectBtn">Refresh project</button>
        </div>
        <div id="projectBody"></div>
      </div>
    </section>

    <section role="tabpanel" id="panel-diff" aria-labelledby="tab-diff" hidden="until-found">
      <div class="panel-inner">
        <div class="section-head">
          <div>
            <h2 class="section-title">Text diff</h2>
            <p class="section-sub">Compare any two text snippets locally. Contents are preserved when repositories refresh.</p>
          </div>
          <div class="inline-row">
            <button type="button" class="sm" id="swapDiffBtn">Swap</button>
            <button type="button" class="sm" id="clearDiffBtn">Clear</button>
            <button type="button" class="sm primary" id="compareDiffBtn">Compare</button>
          </div>
        </div>
        <div class="diff-inputs">
          <div class="diff-pane">
            <label for="diffBefore">Original</label>
            <textarea id="diffBefore" spellcheck="false" placeholder="Paste original text…"></textarea>
          </div>
          <div class="diff-pane">
            <label for="diffAfter">Revised</label>
            <textarea id="diffAfter" spellcheck="false" placeholder="Paste revised text…"></textarea>
          </div>
        </div>
        <div class="section-sub" id="diffSummary">Paste text in both panes, then click Compare.</div>
        <div class="diff-output" id="diffOutput" aria-live="polite">
          <div class="empty-state" style="border:0">Your diff will appear here.</div>
        </div>
      </div>
    </section>

    <section role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" hidden="until-found">
      <div class="panel-inner">
        <div class="section-head">
          <div>
            <h2 class="section-title">Smart Commit &amp; AI Settings</h2>
            <p class="section-sub">Applies to both Source Control commit generation and Command Center batch commits.</p>
          </div>
        </div>
        <div class="settings-layout">
          <div class="settings-card">
            <h3>Commit message formatting</h3>
            <label class="field">
              <span>Default style</span>
              <select id="commitFormat">
                <option value="conventional">Conventional Commits</option>
                <option value="emoji">Emoji</option>
                <option value="simple">Simple</option>
                <option value="detailed">Detailed</option>
              </select>
            </label>
            <label class="field">
              <span>Emoji set</span>
              <select id="emojiStyle">
                <option value="gitmoji">Gitmoji</option>
                <option value="simple">Simple</option>
              </select>
            </label>
            <div class="check-list">
              <label class="check-row"><input id="includeScope" type="checkbox"> Include auto-detected scope</label>
              <label class="check-row"><input id="includeBody" type="checkbox"> Include changed files in commit body</label>
              <label class="check-row"><input id="autoStageIfNone" type="checkbox"> Automatically stage changes when nothing is staged</label>
              <label class="check-row"><input id="fallbackToUnstaged" type="checkbox"> Analyze unstaged changes when nothing is staged</label>
            </div>
            <div class="inline-row">
              <button type="button" class="primary" id="saveCommitSettingsBtn">Save settings</button>
            </div>
          </div>

          <div class="settings-card">
            <h3>OpenAI-compatible AI endpoint (optional)</h3>
            <label class="field">
              <span>Inference API Base URL</span>
              <input id="ollamaUrl" type="text" placeholder="https://inference.example.com/v1 or http://localhost:11434/v1">
              <span class="field-hint">Leave blank to use the built-in local heuristic commit generator.</span>
            </label>
            <label class="field">
              <span>Model</span>
              <select id="ollamaModelSelect">
                <option value="">None (built-in heuristic)</option>
                <option value="__custom__">Custom model name…</option>
              </select>
              <input id="ollamaModelCustom" type="text" placeholder="Enter custom model name" hidden>
              <span class="field-hint">Click Test &amp; load models to populate from <code>/v1/models</code>, or choose Custom to type a model name.</span>
            </label>
            <label class="field">
              <span>API Key <span id="apiKeyBadge" class="field-hint"></span></span>
              <input id="ollamaApiKey" type="password" autocomplete="new-password" placeholder="Optional Bearer token (stored in SecretStorage)">
            </label>
            <div class="inline-row">
              <button type="button" class="primary" id="saveAiSettingsBtn">Save endpoint &amp; model</button>
              <button type="button" id="loadModelsBtn">Test &amp; load models</button>
              <button type="button" id="saveApiKeyBtn">Save API key</button>
              <button type="button" id="clearApiKeyBtn">Clear key</button>
            </div>
            <div class="status-box" id="ollamaStatus">Configure an OpenAI-compatible endpoint URL and model in your user settings.</div>
          </div>
        </div>
      </div>
    </section>
  </main>
</div>

<div class="bottom-progress-dock" id="bottomProgressDock" hidden>
  <div class="win-progress bottom" id="bottomProgressWrap">
    <progress id="bottomProgress" max="100" aria-label="Operation progress"></progress>
  </div>
  <div class="progress-dock-inner" role="status" aria-live="polite">
    <span class="progress-dot" id="progressDot" aria-hidden="true"></span>
    <span class="progress-label" id="progressLabel"></span>
    <span class="progress-detail" id="progressDetail"></span>
    <span class="progress-meta" id="progressMeta"></span>
  </div>
</div>

<script>
const api = acquireVsCodeApi();

const ICONS = {
  sync: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.7M13.5 2.5v3h-3"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 3v10m0 0-3.5-3.5M8 13l3.5-3.5"/></svg>',
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 13V3m0 0L4.5 6.5M8 3l3.5 3.5"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
  edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M11.5 2.5 13.5 4.5 5.5 12.5 2.5 13.5 3.5 10.5z"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 2.5 14 13H2L8 2.5zM8 6.5v3M8 11.2v.3"/></svg>',
  branch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 3-7 3"/></svg>',
  folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>',
  terminal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 5l3 3-3 3M8 11h5"/></svg>'
};

const ui = {
  state: null,
  progress: null,
  activeTab: 'tab-overview',
  filter: 'all',
  search: '',
  sort: 'priority',
  settingsHydrated: false
};

function renderProgress(p) {
  ui.progress = p || null;
  const topWrap = document.getElementById('topProgressWrap');
  const topBar = document.getElementById('topProgress');
  const bottomDock = document.getElementById('bottomProgressDock');
  const bottomWrap = document.getElementById('bottomProgressWrap');
  const bottomBar = document.getElementById('bottomProgress');
  const labelEl = document.getElementById('progressLabel');
  const detailEl = document.getElementById('progressDetail');
  const metaEl = document.getElementById('progressMeta');
  if (!topWrap || !topBar || !bottomDock || !bottomWrap || !bottomBar) return;

  if (!p) {
    topWrap.hidden = true;
    bottomDock.hidden = true;
    updateActionButtonStates(null);
    return;
  }

  const tone = p.tone || 'accent';
  topWrap.hidden = false;
  bottomDock.hidden = false;
  topWrap.dataset.tone = tone;
  bottomWrap.dataset.tone = tone;
  bottomDock.dataset.tone = tone;
  bottomDock.dataset.active = String(!!p.active);

  if (typeof p.percent === 'number' && Number.isFinite(p.percent)) {
    const val = Math.max(0, Math.min(100, Math.round(p.percent)));
    topBar.value = val;
    bottomBar.value = val;
    metaEl.textContent = p.active ? (val + '%') : 'Done';
  } else {
    topBar.removeAttribute('value');
    bottomBar.removeAttribute('value');
    metaEl.textContent = p.active ? 'Working…' : 'Done';
  }

  labelEl.textContent = p.label || '';
  detailEl.textContent = p.detail || '';
  detailEl.title = p.detail || '';
  updateActionButtonStates(p);
}

function updateActionButtonStates(p) {
  const isAction = (name) => !!(p && p.active && p.action === name);
  const refreshProjectBtn = document.getElementById('refreshProjectBtn');
  if (refreshProjectBtn) {
    refreshProjectBtn.disabled = isAction('refreshProject');
    refreshProjectBtn.textContent = isAction('refreshProject') ? 'Refreshing…' : 'Refresh project';
  }
  const loadModelsBtn = document.getElementById('loadModelsBtn');
  if (loadModelsBtn) {
    loadModelsBtn.disabled = isAction('loadModels');
    loadModelsBtn.textContent = isAction('loadModels') ? 'Loading models…' : 'Test & load models';
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Accessible Tabs */
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

function selectTab(tabId, focusTab = false) {
  ui.activeTab = tabId;
  for (const tab of tabs) {
    const selected = tab.id === tabId;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.dataset.panel);
    if (panel) {
      if (selected) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', 'until-found');
    }
    if (selected && focusTab) {
      tab.focus();
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.id));
  tab.addEventListener('keydown', e => {
    const i = tabs.indexOf(tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next >= 0) {
      e.preventDefault();
      selectTab(tabs[next].id, true);
    }
  });
}

for (const panel of panels) {
  panel.addEventListener('beforematch', () => {
    const owner = tabs.find(t => t.dataset.panel === panel.id);
    if (owner) selectTab(owner.id);
  });
}

/* Repo classification */
function repoState(r) {
  if (r.error) return 'error';
  if (r.behind > 0 && r.ahead > 0) return 'diverged';
  if (r.behind > 0) return 'behind';
  if (r.changes > 0) return 'dirty';
  if (r.ahead > 0) return 'ahead';
  if (!r.hasUpstream) return 'local';
  return 'synced';
}

function renderRepoCard(r, state) {
  const st = repoState(r);
  const isSyncing = state.syncingPaths.includes(r.path);
  const activeLabel = (state.activePathLabels && state.activePathLabels[r.path]) || 'Syncing…';
  const isCurrent = state.currentRepoPath && r.path.toLowerCase() === state.currentRepoPath.toLowerCase();

  let syncButton = '';
  if (isSyncing) {
    syncButton = '<button type="button" class="sm primary" disabled><span class="spin">' + ICONS.sync + '</span> ' + esc(activeLabel) + '</button>';
  } else if (!r.hasUpstream) {
    syncButton = '<button type="button" class="sm" disabled title="No upstream remote branch configured">Local only</button>';
  } else if (r.behind > 0 && r.ahead > 0) {
    syncButton = '<button type="button" class="sm warn-btn" data-action="syncRepo" data-path="' + esc(r.path) + '" title="Pull incoming and push outgoing commits">' + ICONS.sync + ' Sync ↓' + r.behind + ' ↑' + r.ahead + '</button>';
  } else if (r.behind > 0) {
    syncButton = '<button type="button" class="sm warn-btn" data-action="syncRepo" data-path="' + esc(r.path) + '" title="Pull ' + r.behind + ' incoming commit(s)">' + ICONS.down + ' Pull ↓' + r.behind + '</button>';
  } else if (r.ahead > 0) {
    syncButton = '<button type="button" class="sm primary" data-action="syncRepo" data-path="' + esc(r.path) + '" title="Push ' + r.ahead + ' outgoing commit(s)">' + ICONS.up + ' Push ↑' + r.ahead + '</button>';
  } else {
    syncButton = '<button type="button" class="sm" data-action="syncRepo" data-path="' + esc(r.path) + '" title="Fetch and check for remote updates">' + ICONS.sync + ' Sync</button>';
  }

  const pills = [];
  if (r.behind > 0) pills.push('<span class="pill bad">' + ICONS.down + ' ' + r.behind + ' behind</span>');
  if (r.ahead > 0) pills.push('<span class="pill info">' + ICONS.up + ' ' + r.ahead + ' ahead</span>');
  if (r.changes > 0) pills.push('<span class="pill warn">' + ICONS.edit + ' ' + r.changes + ' uncommitted</span>');
  if (r.behind === 0 && r.ahead === 0 && r.changes === 0 && r.hasUpstream && !r.error) {
    pills.push('<span class="pill ok">' + ICONS.check + ' In sync</span>');
  }
  if (!r.hasUpstream && !r.error) pills.push('<span class="pill muted">No upstream</span>');
  if (r.outdated) pills.push('<span class="pill warn">' + r.outdated + ' outdated npm</span>');
  if (r.error) pills.push('<span class="pill bad">' + ICONS.warn + ' Check failed</span>');
  if (r.missingReadme) pills.push('<button type="button" class="sm" data-action="fix" data-issue="readme" data-path="' + esc(r.path) + '">+ README</button>');
  if (r.missingLicense) pills.push('<button type="button" class="sm" data-action="fix" data-issue="license" data-path="' + esc(r.path) + '">+ License</button>');

  return (
    '<article class="repo-card" data-state="' + st + '"' + (isSyncing ? ' data-busy="true"' : '') + '>' +
      '<header>' +
        '<div class="repo-id">' +
          '<div class="repo-name-row">' +
            '<h3 class="repo-name">' + esc(r.name) + '</h3>' +
            (isCurrent ? '<span class="ws-tag">Current</span>' : '') +
          '</div>' +
          '<div class="repo-path">' + esc(r.path) + '</div>' +
        '</div>' +
        '<div class="repo-head-actions">' +
          syncButton +
        '</div>' +
      '</header>' +
      '<div class="repo-signals">' + pills.join('') + '</div>' +
      '<footer>' +
        '<span class="branch-meta">' + ICONS.branch + ' ' + esc(r.branch || 'Detached / unknown') + '</span>' +
        '<div class="footer-actions">' +
          (r.hasBuild ? '<button type="button" class="sm" data-action="run" data-script="build" data-path="' + esc(r.path) + '">Build</button>' : '') +
          (r.hasTest ? '<button type="button" class="sm" data-action="run" data-script="test" data-path="' + esc(r.path) + '">Test</button>' : '') +
          '<button type="button" class="sm" data-action="openTerminal" data-path="' + esc(r.path) + '" title="Open terminal">' + ICONS.terminal + '</button>' +
          '<button type="button" class="sm" data-action="open" data-path="' + esc(r.path) + '" title="Open in new window">' + ICONS.folder + ' Open</button>' +
        '</div>' +
      '</footer>' +
    '</article>'
  );
}

function renderState(state) {
  ui.state = state;
  const repos = state.repos || [];
  const behindRepos = repos.filter(r => r.behind > 0);
  const aheadRepos = repos.filter(r => r.ahead > 0);
  const dirtyRepos = repos.filter(r => r.changes > 0);
  const needSyncRepos = repos.filter(r => r.behind > 0 || r.ahead > 0);
  const readyToSync = repos.filter(r => r.hasUpstream && (r.behind > 0 || r.ahead > 0) && !(r.behind > 0 && r.changes > 0));
  const readyToPush = repos.filter(r => r.hasUpstream && r.ahead > 0 && r.behind === 0);
  const attentionRepos = repos.filter(r => r.behind > 0 || r.ahead > 0 || r.changes > 0 || r.error);
  const toolRepos = repos.filter(r => r.hasBuild || r.hasTest);

  // Header metadata & buttons
  document.getElementById('startupCheck').checked = !!state.showOnStartup;
  const metaParts = [repos.length + ' repositories'];
  if (state.lastCheckedAt) metaParts.push('Checked ' + state.lastCheckedAt);
  if (state.lastFetchedAt) metaParts.push('Remotes fetched ' + state.lastFetchedAt);
  else metaParts.push('Click Check Remotes to fetch incoming commits');
  document.getElementById('brandMeta').textContent = metaParts.join(' · ');

  const anyBatch = !!state.batchAction;
  const refreshBtn = document.getElementById('refreshBtn');
  const fetchBtn = document.getElementById('fetchAllBtn');
  refreshBtn.disabled = state.busy || state.fetchingRemotes || anyBatch;
  fetchBtn.disabled = state.busy || state.fetchingRemotes || anyBatch;
  document.getElementById('refreshLabel').textContent = state.busy ? 'Scanning…' : 'Refresh';
  document.getElementById('fetchAllLabel').textContent = state.fetchingRemotes ? 'Fetching…' : 'Check Remotes';
  if (state.progress !== undefined) {
    renderProgress(state.progress);
  }

  // Tab badges
  const attBadge = document.getElementById('count-attention');
  attBadge.textContent = String(attentionRepos.length);
  attBadge.classList.toggle('alert', needSyncRepos.length > 0);
  document.getElementById('count-repos').textContent = String(repos.length);
  document.getElementById('count-tools').textContent = String(toolRepos.length);
  document.getElementById('count-project').textContent = String((state.projectErrors?.length || 0) + (state.projectPorts?.length || 0));

  // Sync Hero Banner
  let level = 'ok';
  let icon = ICONS.check;
  let title = 'All ' + repos.length + ' repositories are in sync';
  let sub = state.lastFetchedAt
    ? 'Remotes last checked at ' + state.lastFetchedAt + '. No incoming or outgoing commits detected.'
    : 'Local status is clean. Click Check Remotes to verify whether any upstream branches have new commits.';

  if (behindRepos.length > 0) {
    level = 'bad';
    icon = ICONS.down;
    title = 'Sync needed — ' + behindRepos.length + ' repo' + (behindRepos.length === 1 ? '' : 's') + ' behind remote';
    sub = [
      behindRepos.length + ' to pull',
      aheadRepos.length ? aheadRepos.length + ' to push' : '',
      dirtyRepos.length ? dirtyRepos.length + ' with uncommitted changes' : ''
    ].filter(Boolean).join(' · ');
  } else if (aheadRepos.length > 0) {
    level = 'info';
    icon = ICONS.up;
    title = 'Push needed — ' + aheadRepos.length + ' repo' + (aheadRepos.length === 1 ? '' : 's') + ' ahead of remote';
    sub = [
      aheadRepos.length + ' with outgoing commits',
      dirtyRepos.length ? dirtyRepos.length + ' with uncommitted changes' : ''
    ].filter(Boolean).join(' · ');
  } else if (dirtyRepos.length > 0) {
    level = 'warn';
    icon = ICONS.edit;
    title = dirtyRepos.length + ' repo' + (dirtyRepos.length === 1 ? '' : 's') + ' have uncommitted changes';
    sub = 'Commit your working tree changes when ready to sync with remote.';
  }

  document.getElementById('syncBanner').innerHTML =
    '<div class="sync-banner" data-level="' + level + '">' +
      '<div class="banner-left">' +
        '<div class="banner-icon">' + icon + '</div>' +
        '<div>' +
          '<h2 class="banner-title">' + esc(title) + '</h2>' +
          '<p class="banner-sub">' + esc(sub) + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="banner-actions">' +
        '<button type="button" data-action="fetchAll"' + (state.fetchingRemotes || state.busy || anyBatch ? ' disabled' : '') + '>' + (state.fetchingRemotes ? '<span class="spin">' + ICONS.sync + '</span> Fetching…' : ICONS.down + ' Check Remotes') + '</button>' +
        (readyToSync.length > 0
          ? '<button type="button" class="primary" data-action="syncAll"' + (anyBatch || state.busy || state.fetchingRemotes ? ' disabled' : '') + '>' + (state.batchAction === 'syncAll' ? '<span class="spin">' + ICONS.sync + '</span> Syncing…' : ICONS.sync + ' Sync All Ready (' + readyToSync.length + ')') + '</button>'
          : '') +
      '</div>' +
    '</div>';

  // Current workspace highlight
  const currentRepo = state.currentRepoPath
    ? repos.find(r => r.path.toLowerCase() === state.currentRepoPath.toLowerCase())
    : null;
  document.getElementById('currentWorkspaceSection').innerHTML = currentRepo
    ? '<div class="section-head"><div><h2 class="section-title">Current workspace</h2></div></div>' +
      '<div class="repo-grid">' + renderRepoCard(currentRepo, state) + '</div>'
    : '';

  // KPI strip
  const localOnlyCount = repos.filter(r => !r.hasUpstream).length;
  document.getElementById('kpiGrid').innerHTML = [
    { label: 'Incoming (Pull)', val: behindRepos.length, tone: behindRepos.length ? 'bad' : 'ok', filter: 'behind' },
    { label: 'Outgoing (Push)', val: aheadRepos.length, tone: aheadRepos.length ? 'info' : 'ok', filter: 'ahead' },
    { label: 'Uncommitted', val: dirtyRepos.length, tone: dirtyRepos.length ? 'warn' : 'ok', filter: 'dirty' },
    { label: 'In Sync', val: repos.filter(r => repoState(r) === 'synced').length, tone: 'ok', filter: 'clean' },
    { label: 'Local Only', val: localOnlyCount, tone: 'neutral', filter: 'local' },
    { label: 'Total Repos', val: repos.length, tone: 'neutral', filter: 'all' }
  ].map(k =>
    '<button type="button" class="kpi" data-tone="' + k.tone + '" data-jump-filter="' + k.filter + '">' +
      '<span class="kpi-label">' + esc(k.label) + '</span>' +
      '<strong class="kpi-val">' + k.val + '</strong>' +
    '</button>'
  ).join('');

  // Overview Needs Attention grid
  const attHtml = attentionRepos.length
    ? attentionRepos.slice(0, 8).map(r => renderRepoCard(r, state)).join('')
    : '<div class="empty-state">All scanned repositories are clean and up to date.</div>';
  document.getElementById('attentionGrid').innerHTML = attHtml;

  // Batch actions
  const batchBusy = anyBatch || state.busy || state.fetchingRemotes;
  const syncAllLabel = state.batchAction === 'syncAll'
    ? '<span class="spin">' + ICONS.sync + '</span> Syncing…'
    : ICONS.sync + ' Sync ready (' + readyToSync.length + ')';
  const commitAllLabel = state.batchAction === 'commitAll'
    ? '<span class="spin">' + ICONS.sync + '</span> Committing…'
    : ICONS.edit + ' Commit changed (' + dirtyRepos.length + ')';
  const pushAllLabel = state.batchAction === 'pushAll'
    ? '<span class="spin">' + ICONS.sync + '</span> Pushing…'
    : ICONS.up + ' Push ready (' + readyToPush.length + ')';

  document.getElementById('batchActions').innerHTML =
    '<div class="action-card">' +
      '<h3>Sync all ready</h3>' +
      '<p>Fetches, pulls incoming commits, and pushes outgoing commits for clean repositories with an upstream branch.</p>' +
      '<button type="button" class="primary" data-action="syncAll"' + (readyToSync.length && !batchBusy ? '' : ' disabled') + '>' + syncAllLabel + '</button>' +
    '</div>' +
    '<div class="action-card">' +
      '<h3>Commit all changes</h3>' +
      '<p>Stages and commits each repository with uncommitted changes using Smart Commit.</p>' +
      '<button type="button" class="primary" data-action="commitAll"' + (dirtyRepos.length && !batchBusy ? '' : ' disabled') + '>' + commitAllLabel + '</button>' +
    '</div>' +
    '<div class="action-card">' +
      '<h3>Push outgoing commits</h3>' +
      '<p>Pushes repositories that are ahead of remote and have no incoming commits.</p>' +
      '<button type="button" class="primary" data-action="pushAll"' + (readyToPush.length && !batchBusy ? '' : ' disabled') + '>' + pushAllLabel + '</button>' +
    '</div>';

  // Repositories tab filters & list
  renderReposTab(state);

  // Build & Test tab
  document.getElementById('toolsGrid').innerHTML = toolRepos.length
    ? toolRepos.map(r =>
        '<article class="repo-card" data-state="' + repoState(r) + '">' +
          '<header><div class="repo-id"><h3 class="repo-name">' + esc(r.name) + '</h3><div class="repo-path">' + esc(r.path) + '</div></div></header>' +
          '<footer><span class="branch-meta">' + ICONS.branch + ' ' + esc(r.branch || 'unknown') + '</span>' +
          '<div class="footer-actions">' +
            (r.hasBuild ? '<button type="button" class="sm primary" data-action="run" data-script="build" data-path="' + esc(r.path) + '">Run Build</button>' : '') +
            (r.hasTest ? '<button type="button" class="sm" data-action="run" data-script="test" data-path="' + esc(r.path) + '">Run Tests</button>' : '') +
          '</div></footer>' +
        '</article>'
      ).join('')
    : '<div class="empty-state">No npm build or test scripts were found in the scanned repositories.</div>';

  // Project tab
  if (!state.workspace) {
    document.getElementById('projectPathLabel').textContent = 'Open a project folder to inspect listening ports, running tasks, and errors.';
    document.getElementById('projectBody').innerHTML = '<div class="empty-state">No active workspace folder.</div>';
  } else {
    document.getElementById('projectPathLabel').textContent = state.workspace.name + ' · ' + state.workspace.path;
    const portsHtml = (state.projectPorts || []).map(p =>
      '<article class="repo-card"><header><div class="repo-id"><h3 class="repo-name">' + esc(p.address) + ':' + p.port + '</h3><div class="repo-path">' + esc(p.process) + '</div></div></header></article>'
    ).join('') || '<div class="empty-state">No project-associated listening ports detected.</div>';
    const tasksHtml = (state.projectTasks || []).map(t =>
      '<article class="repo-card"><header><div class="repo-id"><h3 class="repo-name">' + esc(t) + '</h3></div></header></article>'
    ).join('') || '<div class="empty-state">No running tasks.</div>';
    const errsHtml = (state.projectErrors || []).map(e =>
      '<article class="repo-card" data-state="error"><header><div class="repo-id"><h3 class="repo-name">' + esc(e.file) + ':' + e.line + '</h3><div class="repo-path">' + esc(e.message) + '</div></div></header></article>'
    ).join('') || '<div class="empty-state">No current workspace errors.</div>';

    document.getElementById('projectBody').innerHTML =
      '<div class="kpi-grid">' +
        '<div class="kpi"><span class="kpi-label">Listening Ports</span><strong class="kpi-val">' + state.projectPorts.length + '</strong></div>' +
        '<div class="kpi"><span class="kpi-label">Running Tasks</span><strong class="kpi-val">' + state.projectTasks.length + '</strong></div>' +
        '<div class="kpi" data-tone="' + (state.projectErrors.length ? 'bad' : 'ok') + '"><span class="kpi-label">Errors</span><strong class="kpi-val">' + state.projectErrors.length + '</strong></div>' +
      '</div>' +
      '<h3 class="section-title" style="margin-top:14px">Server ports</h3><div class="repo-grid">' + portsHtml + '</div>' +
      '<h3 class="section-title" style="margin-top:14px">Running tasks</h3><div class="repo-grid">' + tasksHtml + '</div>' +
      '<h3 class="section-title" style="margin-top:14px">Recent errors</h3><div class="repo-grid">' + errsHtml + '</div>';
  }

  // Hydrate settings once (or update API key badge)
  const cs = state.commitSettings;
  if (cs) {
    document.getElementById('apiKeyBadge').textContent = cs.ollamaKeyConfigured ? '· Configured (stored securely)' : '· Not configured';
    if (!ui.settingsHydrated) {
      document.getElementById('commitFormat').value = cs.format || 'conventional';
      document.getElementById('emojiStyle').value = cs.emojiStyle || 'gitmoji';
      document.getElementById('includeScope').checked = !!cs.includeScope;
      document.getElementById('includeBody').checked = !!cs.includeBody;
      document.getElementById('autoStageIfNone').checked = !!cs.autoStageIfNone;
      document.getElementById('fallbackToUnstaged').checked = !!cs.fallbackToUnstaged;
      document.getElementById('ollamaUrl').value = cs.ollamaUrl || '';
      renderModelOptions(ui.loadedModels || [], cs.ollamaModel || '');
      ui.settingsHydrated = true;
    }
  }
}

function renderReposTab(state) {
  const repos = state.repos || [];
  const counts = {
    all: repos.length,
    sync: repos.filter(r => r.behind > 0 || r.ahead > 0).length,
    behind: repos.filter(r => r.behind > 0).length,
    ahead: repos.filter(r => r.ahead > 0).length,
    dirty: repos.filter(r => r.changes > 0).length,
    issues: repos.filter(r => r.missingReadme || r.missingLicense || r.outdated || r.error).length,
    clean: repos.filter(r => repoState(r) === 'synced').length,
    local: repos.filter(r => !r.hasUpstream).length
  };

  const defs = [
    ['all', 'All'],
    ['sync', 'Needs Sync'],
    ['behind', 'Incoming ↓'],
    ['ahead', 'Outgoing ↑'],
    ['dirty', 'Uncommitted'],
    ['issues', 'Health'],
    ['clean', 'In Sync'],
    ['local', 'Local']
  ];

  document.getElementById('filterPills').innerHTML = defs.map(([id, label]) =>
    '<button type="button" class="chip" data-filter="' + id + '" aria-pressed="' + (ui.filter === id) + '">' +
      label + ' (' + counts[id] + ')' +
    '</button>'
  ).join('');

  const q = ui.search.trim().toLowerCase();
  let filtered = repos.filter(r => {
    if (ui.filter === 'sync' && !(r.behind > 0 || r.ahead > 0)) return false;
    if (ui.filter === 'behind' && !(r.behind > 0)) return false;
    if (ui.filter === 'ahead' && !(r.ahead > 0)) return false;
    if (ui.filter === 'dirty' && !(r.changes > 0)) return false;
    if (ui.filter === 'issues' && !(r.missingReadme || r.missingLicense || r.outdated || r.error)) return false;
    if (ui.filter === 'clean' && repoState(r) !== 'synced') return false;
    if (ui.filter === 'local' && r.hasUpstream) return false;
    if (q) {
      const hay = (r.name + ' ' + (r.branch || '') + ' ' + r.path).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered = filtered.slice().sort((a, b) => {
    if (ui.sort === 'name') return a.name.localeCompare(b.name);
    if (ui.sort === 'changes') return (b.changes - a.changes) || a.name.localeCompare(b.name);
    if (ui.sort === 'commits') return ((b.behind + b.ahead) - (a.behind + a.ahead)) || a.name.localeCompare(b.name);
    return 0; // already priority sorted
  });

  document.getElementById('allReposGrid').innerHTML = filtered.length
    ? filtered.map(r => renderRepoCard(r, state)).join('')
    : '<div class="empty-state">No repositories match the current filter.</div>';
}

/* Global event delegation */
document.addEventListener('click', e => {
  const target = e.target instanceof Element ? e.target.closest('button') : null;
  if (!target) return;

  if (target.dataset.filter) {
    ui.filter = target.dataset.filter;
    if (ui.state) renderReposTab(ui.state);
    return;
  }
  if (target.dataset.jumpFilter) {
    ui.filter = target.dataset.jumpFilter;
    selectTab('tab-repos');
    if (ui.state) renderReposTab(ui.state);
    return;
  }
  const action = target.dataset.action;
  if (!action) return;

  if (action === 'fetchAll') api.postMessage({ command: 'fetchAll' });
  else if (action === 'syncAll') api.postMessage({ command: 'syncAll' });
  else if (action === 'commitAll') api.postMessage({ command: 'commitAll' });
  else if (action === 'pushAll') api.postMessage({ command: 'pushAll' });
  else if (action === 'syncRepo') api.postMessage({ command: 'syncRepo', path: target.dataset.path });
  else if (action === 'open') api.postMessage({ command: 'open', path: target.dataset.path });
  else if (action === 'openTerminal') api.postMessage({ command: 'openTerminal', path: target.dataset.path });
  else if (action === 'run') api.postMessage({ command: 'run', path: target.dataset.path, script: target.dataset.script });
  else if (action === 'fix') api.postMessage({ command: 'fix', path: target.dataset.path, issue: target.dataset.issue });
});

document.getElementById('refreshBtn').onclick = () => api.postMessage({ command: 'refresh' });
document.getElementById('fetchAllBtn').onclick = () => api.postMessage({ command: 'fetchAll' });
document.getElementById('refreshProjectBtn').onclick = () => api.postMessage({ command: 'refreshProject' });
document.getElementById('viewAllReposBtn').onclick = () => { ui.filter = 'all'; selectTab('tab-repos'); if (ui.state) renderReposTab(ui.state); };
document.getElementById('startupCheck').onchange = e => api.postMessage({ command: 'updateStartupSetting', value: e.target.checked });
document.getElementById('repoSearch').oninput = e => { ui.search = e.target.value; if (ui.state) renderReposTab(ui.state); };
document.getElementById('repoSort').onchange = e => { ui.sort = e.target.value; if (ui.state) renderReposTab(ui.state); };

function renderModelOptions(models, currentValue) {
  const select = document.getElementById('ollamaModelSelect');
  const customInput = document.getElementById('ollamaModelCustom');
  const names = [...new Set((models || []).map(m => typeof m === 'string' ? m : m.name).filter(Boolean))];
  if (currentValue && !names.includes(currentValue)) {
    names.unshift(currentValue);
  }
  select.innerHTML =
    '<option value="">None (built-in heuristic)</option>' +
    names.map(name => '<option value="' + esc(name) + '">' + esc(name) + '</option>').join('') +
    '<option value="__custom__">Custom model name…</option>';
  select.value = currentValue || '';
  customInput.hidden = true;
}

function getSelectedModel() {
  const select = document.getElementById('ollamaModelSelect');
  if (select.value === '__custom__') {
    return document.getElementById('ollamaModelCustom').value.trim();
  }
  return select.value.trim();
}

document.getElementById('ollamaModelSelect').onchange = e => {
  const customInput = document.getElementById('ollamaModelCustom');
  const isCustom = e.target.value === '__custom__';
  customInput.hidden = !isCustom;
  if (isCustom) customInput.focus();
};

function saveCommitSettings() {
  api.postMessage({
    command: 'updateCommitSettings',
    values: {
      format: document.getElementById('commitFormat').value,
      emojiStyle: document.getElementById('emojiStyle').value,
      includeScope: document.getElementById('includeScope').checked,
      includeBody: document.getElementById('includeBody').checked,
      autoStageIfNone: document.getElementById('autoStageIfNone').checked,
      fallbackToUnstaged: document.getElementById('fallbackToUnstaged').checked,
      ollamaUrl: document.getElementById('ollamaUrl').value.trim(),
      ollamaModel: getSelectedModel()
    }
  });
}

document.getElementById('saveCommitSettingsBtn').onclick = saveCommitSettings;
document.getElementById('saveAiSettingsBtn').onclick = saveCommitSettings;
document.getElementById('loadModelsBtn').onclick = () => {
  saveCommitSettings();
  document.getElementById('ollamaStatus').textContent = 'Querying /v1/models…';
  api.postMessage({ command: 'loadOllamaModels', url: document.getElementById('ollamaUrl').value.trim() });
};
document.getElementById('saveApiKeyBtn').onclick = () => {
  api.postMessage({ command: 'setOllamaApiKey', value: document.getElementById('ollamaApiKey').value });
  document.getElementById('ollamaApiKey').value = '';
};
document.getElementById('clearApiKeyBtn').onclick = () => {
  document.getElementById('ollamaApiKey').value = '';
  api.postMessage({ command: 'setOllamaApiKey', value: '' });
};

/* Diff viewer */
document.getElementById('swapDiffBtn').onclick = () => {
  const a = document.getElementById('diffBefore');
  const b = document.getElementById('diffAfter');
  const tmp = a.value;
  a.value = b.value;
  b.value = tmp;
};
document.getElementById('clearDiffBtn').onclick = () => {
  document.getElementById('diffBefore').value = '';
  document.getElementById('diffAfter').value = '';
  document.getElementById('diffSummary').textContent = 'Paste text in both panes, then click Compare.';
  document.getElementById('diffOutput').innerHTML = '<div class="empty-state" style="border:0">Your diff will appear here.</div>';
};
document.getElementById('compareDiffBtn').onclick = () => {
  const a = document.getElementById('diffBefore').value.split(/\\r?\\n/);
  const b = document.getElementById('diffAfter').value.split(/\\r?\\n/);
  const n = a.length, m = b.length;
  const out = document.getElementById('diffOutput');
  const summary = document.getElementById('diffSummary');
  if ((n + 1) * (m + 1) > 4000000) {
    summary.textContent = 'Inputs exceed the in-browser comparison limit.';
    out.innerHTML = '<div class="empty-state" style="border:0">Try comparing smaller snippets.</div>';
    return;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0, oldNo = 1, newNo = 1, added = 0, removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      rows.push({ kind: 'context', old: oldNo++, next: newNo++, text: a[i++] });
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] > dp[i + 1][j])) {
      rows.push({ kind: 'add', old: '', next: newNo++, text: b[j++] });
      added++;
    } else {
      rows.push({ kind: 'remove', old: oldNo++, next: '', text: a[i++] });
      removed++;
    }
  }
  out.innerHTML = rows.map(r =>
    '<div class="diff-row ' + r.kind + '">' +
      '<span class="ln">' + r.old + '</span>' +
      '<span class="ln">' + r.next + '</span>' +
      '<span class="mk">' + (r.kind === 'add' ? '+' : r.kind === 'remove' ? '-' : ' ') + '</span>' +
      '<span class="cd">' + esc(r.text || ' ') + '</span>' +
    '</div>'
  ).join('') || '<div class="empty-state" style="border:0">No differences.</div>';
  summary.textContent = added || removed ? '+' + added + ' additions, -' + removed + ' removals' : 'Files are identical.';
};

/* Extension messages */
window.addEventListener('message', event => {
  const m = event.data;
  if (m.command === 'progress') {
    renderProgress(m.payload);
  }
  if (m.command === 'state') {
    renderState(m.payload);
  }
  if (m.command === 'ollamaModels') {
    ui.loadedModels = m.models || [];
    const current = getSelectedModel() || m.selectedModel || '';
    renderModelOptions(ui.loadedModels, current);
    document.getElementById('ollamaStatus').textContent = m.error
      ? m.error
      : 'Connected — ' + ui.loadedModels.length + ' model(s) available from /v1/models.';
  }
});

api.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}

function errorText(e: unknown): string {
  const anyError = e as { stderr?: string; message?: string };
  return (anyError.stderr || anyError.message || String(e)).trim().slice(0, 240);
}

async function findProjectPorts(root: string): Promise<ProjectPort[]> {
  try {
    if (process.platform === 'win32') {
      const safeRoot = root.replace(/'/g, "''");
      const script = `$root='${safeRoot}'; $procs=@{}; Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId]=$_.CommandLine }; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $cmd=$procs[[int]$_.OwningProcess]; if ($cmd -and $cmd.Contains($root)) { [pscustomobject]@{port=$_.LocalPort;address=$_.LocalAddress;process=$cmd} } } | ConvertTo-Json -Compress`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024
      });
      const parsed = JSON.parse(stdout || '[]');
      return (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).map((p: any) => ({
        port: Number(p.port),
        address: String(p.address),
        process: String(p.process)
      }));
    }
    const { stdout } = await execFileAsync('sh', ['-lc', 'ss -ltnp'], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    const found: ProjectPort[] = [];
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const match = line.match(/\s+(\S+):(\d+)\s+.*pid=(\d+)/);
      if (!match) continue;
      const pid = match[3];
      const command = await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => '');
      if (cwd === root || command.includes(root)) {
        found.push({
          address: match[1],
          port: Number(match[2]),
          process: command.replace(/\0/g, ' ').trim() || `PID ${pid}`
        });
      }
    }
    return found;
  } catch {
    return [];
  }
}

function runGitWithOutput(cwd: string, args: string[], output: vscode.OutputChannel): Promise<void> {
  return spawnGitWithOutput(cwd, args, output);
}
