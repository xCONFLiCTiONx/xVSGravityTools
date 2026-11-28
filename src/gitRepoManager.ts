import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { RepoCommandCenter } from './repoCommandCenter';
import { execGit } from './gitProcess';

/** synced = green, committed = yellow (committed but not synced), dirty = red (uncommitted changes), none = not a repo */
export type SyncStatus = 'synced' | 'committed' | 'dirty' | 'none';
export type RepoVisibility = 'public' | 'private' | 'local';

export interface GitRepository {
    name: string;
    path: string;
    parentDir: string;
    branch?: string;
    isPinned: boolean;
    syncStatus?: SyncStatus;
    visibility?: RepoVisibility;
    remoteUrl?: string;
    ahead?: number;
    behind?: number;
    changes?: number;
    hasUpstream?: boolean;
}

export type TreeItemType = 'category' | 'repo' | 'empty';

function runGit(cwd: string, args: string[]): Promise<string> {
    return execGit(args, { cwd, timeoutMs: 15000, noOptionalLocks: true });
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

const remoteVisibilityCache = new Map<string, RepoVisibility>();

function parseRemoteUrl(rawUrl: string): { host: string; slug: string } | null {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    // Standard URLs with scheme: https://, http://, ssh://, git://
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
        try {
            const u = new URL(trimmed);
            if (u.protocol === 'file:') return null;
            const host = u.hostname.toLowerCase().replace(/^www\./, '');
            const slug = u.pathname.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
            if (host && slug) {
                return { host, slug };
            }
        } catch {}
    }

    // SCP-like SSH syntax: [user@]host:owner/repo.git (excluding single-letter Windows drive paths like C:\...)
    const scpMatch = trimmed.match(/^(?:[^@:\s]+@)?([a-zA-Z0-9.-]+\.[a-zA-Z0-9.-]+|[a-zA-Z0-9_-]{2,}):(.+)$/);
    if (scpMatch) {
        const host = scpMatch[1].toLowerCase().replace(/^www\./, '');
        const slug = scpMatch[2].replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
        if (host && slug) {
            return { host, slug };
        }
    }

    return null;
}

function httpsQuery(url: string, method: 'HEAD' | 'GET' = 'HEAD'): Promise<{ statusCode: number; location?: string; body: string }> {
    return new Promise((resolve) => {
        const req = https.request(
            url,
            {
                method,
                timeout: 3000,
                agent: false,
                headers: {
                    'User-Agent': 'xVSGravityTools/1.0',
                    'Accept': 'application/json, text/html;q=0.8'
                }
            },
            (res) => {
                const statusCode = res.statusCode ?? 0;
                const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
                if (method === 'HEAD') {
                    res.resume();
                    resolve({ statusCode, location, body: '' });
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    if (body.length < 16384) body += chunk;
                });
                res.on('end', () => resolve({ statusCode, location, body }));
            }
        );
        req.on('timeout', () => {
            req.destroy();
            resolve({ statusCode: 0, body: '' });
        });
        req.on('error', () => {
            resolve({ statusCode: 0, body: '' });
        });
        req.end();
    });
}

async function checkRemoteVisibility(remoteUrl: string): Promise<RepoVisibility> {
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed) {
        return 'local';
    }

    const { host, slug } = parsed;

    if (host !== 'github.com' && host !== 'gitlab.com') {
        return 'private';
    }

    const cacheKey = `${host}/${slug.toLowerCase()}`;
    const cached = remoteVisibilityCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    // Strict non-blocking 1-second timeout so network delays NEVER freeze scanning
    try {
        const timeoutPromise = new Promise<RepoVisibility>(resolve => setTimeout(() => resolve('private'), 1000));
        const checkPromise = (async (): Promise<RepoVisibility> => {
            if (host === 'github.com') {
                const res = await httpsQuery(`https://github.com/${slug}`, 'HEAD');
                if (res.statusCode === 200 || ((res.statusCode === 301 || res.statusCode === 302) && res.location && !res.location.includes('/login'))) {
                    return 'public';
                }
            } else if (host === 'gitlab.com') {
                const apiUrl = `https://gitlab.com/api/v4/projects/${encodeURIComponent(slug)}`;
                const res = await httpsQuery(apiUrl, 'GET');
                if (res.statusCode === 200) {
                    try {
                        const data = JSON.parse(res.body);
                        if (data && data.visibility === 'public') return 'public';
                    } catch {}
                }
            }
            return 'private';
        })();

        const result = await Promise.race([checkPromise, timeoutPromise]);
        remoteVisibilityCache.set(cacheKey, result);
        return result;
    } catch {
        return 'private';
    }
}

async function inspectRepoState(repoPath: string): Promise<{
    syncStatus: SyncStatus;
    visibility: RepoVisibility;
    remoteUrl?: string;
    ahead: number;
    behind: number;
    changes: number;
    hasUpstream: boolean;
}> {
    try {
        const out = await runGit(repoPath, ['status', '--porcelain=v1', '-b']);
        const lines = out.split(/\r?\n/).filter(Boolean);
        const header = lines[0] || '';
        const changes = Math.max(0, lines.length - 1);
        const noCommits = header.startsWith('## No commits yet') || header.startsWith('## Initial commit on');
        const hasUpstream = header.includes('...');
        const aheadMatch = header.match(/ahead (\d+)/);
        const behindMatch = header.match(/behind (\d+)/);
        const ahead = aheadMatch ? Number(aheadMatch[1] || 0) : 0;
        const behind = behindMatch ? Number(behindMatch[1] || 0) : 0;
        const outOfSync = ahead > 0 || behind > 0 || /\[gone\]/.test(header);

        let syncStatus: SyncStatus = 'synced';
        if (changes > 0) {
            syncStatus = 'dirty';
        } else if (!hasUpstream || outOfSync || noCommits) {
            syncStatus = 'committed';
        }

        // If there are no commits yet, mark as Local
        if (noCommits) {
            return { syncStatus, visibility: 'local', ahead, behind, changes, hasUpstream };
        }

        // Extract upstream remote name from "## branch...remote/branch"
        let remoteName = 'origin';
        const upstreamPart = header.split('...')[1]?.split(' ')[0];
        if (upstreamPart && upstreamPart.includes('/')) {
            remoteName = upstreamPart.split('/')[0];
        }

        let remoteUrl = (await runGit(repoPath, ['config', '--get', `remote.${remoteName}.url`]).catch(() => '')).trim();
        if (!remoteUrl) {
            const firstRemote = (await runGit(repoPath, ['remote']).catch(() => '')).split(/\r?\n/).map(s => s.trim()).find(Boolean);
            if (firstRemote) {
                remoteName = firstRemote;
                remoteUrl = (await runGit(repoPath, ['config', '--get', `remote.${remoteName}.url`]).catch(() => '')).trim();
            }
        }
        if (!remoteUrl) {
            return { syncStatus, visibility: 'local', ahead, behind, changes, hasUpstream };
        }

        // Check if committed and synced to a remote (either active upstream or existing remote tracking refs)
        if (!hasUpstream) {
            const remoteRefs = (await runGit(repoPath, ['for-each-ref', '--count=1', 'refs/remotes']).catch(() => '')).trim();
            if (!remoteRefs) {
                return { syncStatus, visibility: 'local', ahead, behind, changes, hasUpstream };
            }
        }

        const visibility = await checkRemoteVisibility(remoteUrl);
        return { syncStatus, visibility, remoteUrl, ahead, behind, changes, hasUpstream };
    } catch {
        return { syncStatus: 'none', visibility: 'local', ahead: 0, behind: 0, changes: 0, hasUpstream: false };
    }
}

const STATUS_LABEL: Record<SyncStatus, string> = {
    synced: 'Synced',
    committed: 'Committed, not synced',
    dirty: 'Uncommitted changes',
    none: 'Not a Git repository'
};

const VISIBILITY_LABEL: Record<RepoVisibility, string> = {
    public: 'Public',
    private: 'Private',
    local: 'Local'
};

function statusColor(s?: SyncStatus): vscode.ThemeColor | undefined {
    switch (s) {
        case 'synced': return new vscode.ThemeColor('charts.green');
        case 'committed': return new vscode.ThemeColor('charts.yellow');
        case 'dirty': return new vscode.ThemeColor('charts.red');
        default: return undefined;
    }
}

export class RepoTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly itemType: TreeItemType,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly repo?: GitRepository,
        public readonly children?: RepoTreeItem[],
        public readonly isHiddenItem: boolean = false
    ) {
        super(label, collapsibleState);
        if (itemType === 'repo' && repo) {
            const status = repo.syncStatus ?? 'none';
            const visibility = repo.visibility ?? 'local';
            const visLabel = VISIBILITY_LABEL[visibility];
            const hiddenPrefix = isHiddenItem ? '[Hidden] ' : '';
            const ahead = repo.ahead ?? 0;
            const behind = repo.behind ?? 0;
            const changes = repo.changes ?? 0;
            const syncDetails: string[] = [];
            if (behind > 0) syncDetails.push(`Incoming: ${behind} commit${behind === 1 ? '' : 's'} to pull`);
            if (ahead > 0) syncDetails.push(`Outgoing: ${ahead} commit${ahead === 1 ? '' : 's'} to push`);
            if (changes > 0) syncDetails.push(`Uncommitted: ${changes} file${changes === 1 ? '' : 's'}`);
            this.tooltip = `${hiddenPrefix}${repo.name} (${visLabel})\nPath: ${repo.path}${repo.branch ? `\nBranch: ${repo.branch}` : ''}${repo.remoteUrl ? `\nRemote: ${repo.remoteUrl}` : ''}\nVisibility: ${visLabel}\nStatus: ${STATUS_LABEL[status]}${syncDetails.length ? `\n${syncDetails.join('\n')}` : ''}`;
            const descParts: string[] = [];
            if (isHiddenItem) descParts.push('Hidden');
            if (behind > 0 && ahead > 0) descParts.push(`↓${behind} ↑${ahead}`);
            else if (behind > 0) descParts.push(`↓${behind} pull`);
            else if (ahead > 0) descParts.push(`↑${ahead} push`);
            if (changes > 0) descParts.push(`${changes} mod`);
            descParts.push(visLabel);
            if (repo.branch) descParts.push(repo.branch);
            this.description = descParts.join(' • ');
            if (isHiddenItem) {
                this.contextValue = repo.isPinned ? 'repoItemHiddenPinned' : 'repoItemHidden';
            } else {
                this.contextValue = repo.isPinned ? 'repoItemPinned' : 'repoItem';
            }
            const icon = isHiddenItem ? 'eye-closed' : (status === 'none' ? 'folder' : (behind > 0 || ahead > 0 ? 'sync' : (repo.isPinned ? 'star-full' : 'repo')));
            this.iconPath = new vscode.ThemeIcon(icon, isHiddenItem ? new vscode.ThemeColor('disabledForeground') : statusColor(status));
            this.command = {
                command: 'gitRepoManager.handleTreeItemClick',
                title: 'Open Repository',
                arguments: [repo]
            };
        } else if (itemType === 'category') {
            const isHiddenCat = label.startsWith('Hidden');
            this.contextValue = isHiddenCat ? 'categoryHiddenItem' : 'categoryItem';
            let catIcon = 'folder';
            if (label.startsWith('Needs Sync')) {
                catIcon = 'sync';
            } else if (label.includes('Favorites')) {
                catIcon = 'star-full';
            } else if (isHiddenCat) {
                catIcon = 'eye-closed';
            }
            this.iconPath = new vscode.ThemeIcon(catIcon, label.startsWith('Needs Sync') ? new vscode.ThemeColor('charts.yellow') : undefined);
        } else {
            this.contextValue = 'emptyItem';
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

export class ConfigManager {
    private static readonly SECTION = 'gitRepoManager';

    public static getSearchDirectories(): string[] {
        const configured = vscode.workspace.getConfiguration(this.SECTION).get<string[]>('searchDirectories', []).map(d => d.trim()).filter(Boolean);
        const result = new Set<string>(configured);

        // Auto-include open workspace folders and their parent folders so projects ALWAYS load out of the box
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const wf of workspaceFolders) {
                const fsPath = wf.uri.fsPath;
                if (fs.existsSync(fsPath)) {
                    const parentDir = path.dirname(fsPath);
                    if (parentDir && fs.existsSync(parentDir) && !isIgnoredDirectory(path.basename(parentDir), parentDir)) {
                        result.add(parentDir);
                    } else {
                        result.add(fsPath);
                    }
                }
            }
        }

        return Array.from(result);
    }
    public static async addSearchDirectory(p: string) {
        const config = vscode.workspace.getConfiguration(this.SECTION);
        const dirs = this.getSearchDirectories();
        if (!dirs.includes(p)) await config.update('searchDirectories', [...dirs, p], vscode.ConfigurationTarget.Global);
    }
    public static getScanDepth(): number { return vscode.workspace.getConfiguration(this.SECTION).get<number>('scanDepth', 3); }
    public static getOpenInNewWindow(): boolean { return vscode.workspace.getConfiguration(this.SECTION).get<boolean>('openInNewWindow', false); }
    public static getFavoriteRepos(): string[] { return vscode.workspace.getConfiguration(this.SECTION).get<string[]>('favoriteRepos', []); }
    public static isFavorite(p: string): boolean {
        const favs = this.getFavoriteRepos();
        const norm = p.replace(/\\/g, '/').toLowerCase();
        return favs.some(f => f.replace(/\\/g, '/').toLowerCase() === norm);
    }
    public static async toggleFavorite(p: string): Promise<boolean> {
        const config = vscode.workspace.getConfiguration(this.SECTION);
        const favs = this.getFavoriteRepos();
        const norm = p.replace(/\\/g, '/');
        const index = favs.findIndex(f => f.replace(/\\/g, '/').toLowerCase() === norm.toLowerCase());
        const updated = index >= 0 ? favs.filter((_, i) => i !== index) : [...favs, p];
        await config.update('favoriteRepos', updated, vscode.ConfigurationTarget.Global);
        return index < 0;
    }
    public static getHiddenRepos(): string[] {
        return vscode.workspace.getConfiguration(this.SECTION).get<string[]>('hiddenRepos', ['.notes']);
    }
    public static isHidden(repoPath: string, repoName: string): boolean {
        const hiddenList = this.getHiddenRepos();
        const normPath = repoPath.replace(/\\/g, '/').toLowerCase();
        const normName = repoName.toLowerCase();
        return hiddenList.some(item => {
            const clean = item.trim().replace(/\\/g, '/').toLowerCase();
            if (!clean) return false;
            return clean === normPath || clean === normName || normPath.endsWith('/' + clean);
        });
    }
    public static async hideRepo(repoPath: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.SECTION);
        const hiddenList = this.getHiddenRepos();
        const normPath = repoPath.replace(/\\/g, '/').toLowerCase();
        const normName = path.basename(repoPath).toLowerCase();
        const exists = hiddenList.some(item => {
            const clean = item.trim().replace(/\\/g, '/').toLowerCase();
            return clean === normPath || clean === normName || normPath.endsWith('/' + clean);
        });
        if (!exists) {
            await config.update('hiddenRepos', [...hiddenList, repoPath], vscode.ConfigurationTarget.Global);
        }
    }
    public static async unhideRepo(repoPath: string, repoName?: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.SECTION);
        const hiddenList = this.getHiddenRepos();
        const normPath = repoPath.replace(/\\/g, '/').toLowerCase();
        const normName = (repoName || path.basename(repoPath)).toLowerCase();
        const updated = hiddenList.filter(item => {
            const clean = item.trim().replace(/\\/g, '/').toLowerCase();
            if (!clean) return false;
            if (clean === normPath) return false;
            if (clean === normName) return false;
            if (normPath.endsWith('/' + clean)) return false;
            return true;
        });
        await config.update('hiddenRepos', updated, vscode.ConfigurationTarget.Global);
    }
    public static getGroupByParent(): boolean { return vscode.workspace.getConfiguration(this.SECTION).get<boolean>('groupByParent', true); }
    public static getShowGitBranch(): boolean { return vscode.workspace.getConfiguration(this.SECTION).get<boolean>('showGitBranch', true); }
    public static getExcludePatterns(): string[] { return vscode.workspace.getConfiguration(this.SECTION).get<string[]>('excludePatterns', []); }
    public static getShowCommandCenterOnStartup(): boolean { return vscode.workspace.getConfiguration(this.SECTION).get<boolean>('showCommandCenterOnStartup', false); }
    public static async setShowCommandCenterOnStartup(val: boolean): Promise<void> { await vscode.workspace.getConfiguration(this.SECTION).update('showCommandCenterOnStartup', val, vscode.ConfigurationTarget.Global); }
}

const IGNORED_DIRECTORY_NAMES = new Set<string>([
    '$recycle.bin',
    'recycler',
    'recycled',
    'system volume information',
    'recovery',
    'msocache',
    'perflogs',
    'config.msi',
    'windows',
    'windows.old',
    'windowsapps',
    'wpsystem',
    'wudownloadcache',
    'deliveryoptimization',
    'program files',
    'program files (x86)',
    'programdata',
    'documents and settings',
    'boot',
    'efi',
    'hiberfil.sys',
    'pagefile.sys',
    'swapfile.sys',
    'dumpstack.log',
    'dumpstack.log.tmp',
    'bootmgr',
    'bootnxt',
    'bootsqm.dat',
    'desktop.ini',
    'thumbs.db',
    'autorun.inf',
    '.git',
    '.github',
    '.gitlab',
    '.vscode',
    '.vscode-test',
    '.idea',
    '.vs',
    '.venv',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.astro',
    '.turbo',
    '.parcel-cache',
    '.cache',
    '.gradle',
    '.mvn',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.tox',
    '.terraform',
    '.angular',
    '.expo',
    '.yarn',
    '.pnpm-store',
    '.trash',
    '.ds_store',
    'node_modules',
    'venv',
    'vendor',
    'target',
    'dist',
    'build',
    '__pycache__'
]);

export function isIgnoredDirectory(name: string, fullPath?: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return true;
    if (trimmed.startsWith('$') || trimmed.startsWith('~')) return true;

    const lower = trimmed.toLowerCase();
    if (IGNORED_DIRECTORY_NAMES.has(lower)) return true;
    if (/^found\.\d+$/i.test(trimmed)) return true;

    const excludePatterns = ConfigManager.getExcludePatterns();
    const normPath = fullPath ? fullPath.replace(/\\/g, '/').toLowerCase() : '';
    for (const pattern of excludePatterns) {
        const clean = pattern.replace(/^\*\*\/|\/\*\*$/g, '').trim().toLowerCase();
        if (!clean) continue;
        if (lower === clean || (normPath && (normPath.endsWith('/' + clean) || normPath.includes('/' + clean + '/')))) {
            return true;
        }
    }

    return false;
}

export class RepoScanner {
    constructor(private context: vscode.ExtensionContext) {}

    public getCachedRepos(): GitRepository[] {
        const cached = this.context.globalState.get<GitRepository[]>('gitRepoManager.cachedRepos', []);
        const valid = cached
            .filter(r => fs.existsSync(r.path) && fs.existsSync(path.join(r.path, '.git')) && !isIgnoredDirectory(r.name, r.path))
            .map(r => ({ ...r, isPinned: ConfigManager.isFavorite(r.path) }));
        if (valid.length !== cached.length) {
            this.context.globalState.update('gitRepoManager.cachedRepos', valid).then(undefined, () => {});
        }
        return valid;
    }

    public async scanRepositories(): Promise<GitRepository[]> {
        const searchDirs = ConfigManager.getSearchDirectories();
        const maxDepth = ConfigManager.getScanDepth();
        const showBranch = ConfigManager.getShowGitBranch();
        const repos: GitRepository[] = [];
        const visited = new Set<string>();

        // Scan open workspace folders directly as well, but only include actual Git repositories.
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        for (const wf of workspaceFolders) {
            if (fs.existsSync(wf.uri.fsPath)) {
                await this.scanDir(wf.uri.fsPath, wf.uri.fsPath, 0, maxDepth, showBranch, repos, visited);
            }
        }

        // 2. Scan search directories recursively
        for (const base of searchDirs) {
            if (fs.existsSync(base)) {
                await this.scanDir(base, base, 0, maxDepth, showBranch, repos, visited);
            }
        }

        // Only Git repositories are included; ordinary project folders are intentionally omitted.

        const validRepos = repos.filter(r => fs.existsSync(r.path) && fs.existsSync(path.join(r.path, '.git')));
        const withStatus = await this.refreshStatuses(validRepos);
        const result = withStatus.map(r => ({ ...r, isPinned: ConfigManager.isFavorite(r.path) }));
        result.sort((a, b) => a.name.localeCompare(b.name));
        await this.context.globalState.update('gitRepoManager.cachedRepos', result);
        return result;
    }

    public async refreshStatuses(repos: GitRepository[]): Promise<GitRepository[]> {
        const existingRepos = repos.filter(r => fs.existsSync(r.path));
        const showBranch = ConfigManager.getShowGitBranch();
        return mapWithConcurrency(existingRepos, 8, async r => {
            const gitPath = path.join(r.path, '.git');
            if (!fs.existsSync(gitPath)) {
                return { ...r, syncStatus: 'none' as SyncStatus, visibility: 'local' as RepoVisibility, remoteUrl: undefined, ahead: 0, behind: 0, changes: 0, hasUpstream: false };
            }
            let branch = r.branch;
            if (showBranch) {
                try {
                    const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
                    branch = head.startsWith('ref: refs/heads/') ? head.substring(16) : undefined;
                } catch {}
            }
            const state = await inspectRepoState(r.path);
            return {
                ...r,
                branch,
                syncStatus: state.syncStatus,
                visibility: state.visibility,
                remoteUrl: state.remoteUrl,
                ahead: state.ahead,
                behind: state.behind,
                changes: state.changes,
                hasUpstream: state.hasUpstream
            };
        });
    }

    public async fetchAllRepositories(
        repos: GitRepository[],
        onProgress?: (completed: number, total: number, repoName: string) => void
    ): Promise<{ fetched: number; failed: number }> {
        const targets = repos.filter(r => fs.existsSync(path.join(r.path, '.git')) && (r.hasUpstream || r.remoteUrl));
        let fetched = 0;
        let failed = 0;
        let completed = 0;
        const total = targets.length;
        onProgress?.(0, total, '');
        await mapWithConcurrency(targets, 4, async r => {
            try {
                await execGit(['fetch', '--prune'], { cwd: r.path, timeoutMs: 20000, maxBuffer: 5 * 1024 * 1024 });
                fetched++;
            } catch {
                failed++;
            } finally {
                completed++;
                onProgress?.(completed, total, r.name);
            }
        });
        return { fetched, failed };
    }

    private async scanDir(curr: string, base: string, depth: number, maxDepth: number, showBranch: boolean, results: GitRepository[], visited: Set<string>) {
        const norm = path.normalize(curr).toLowerCase();
        if (visited.has(norm)) return;
        visited.add(norm);

        if (curr !== base && isIgnoredDirectory(path.basename(curr), curr)) return;

        const gitPath = path.join(curr, '.git');
        if (fs.existsSync(gitPath)) {
            const name = path.basename(curr);
            const parent = path.relative(base, path.dirname(curr)) || path.basename(base);
            let branch: string | undefined = undefined;
            if (showBranch) {
                try {
                    const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
                    if (head.startsWith('ref: refs/heads/')) branch = head.substring(16);
                } catch {}
            }
            results.push({ name, path: curr, parentDir: parent, branch, isPinned: ConfigManager.isFavorite(curr) });
            return;
        }

        if (depth >= maxDepth) return;
        try {
            const entries = await fs.promises.readdir(curr, { withFileTypes: true });
            for (const e of entries) {
                if (!e.isDirectory()) continue;
                const nextPath = path.join(curr, e.name);
                if (!isIgnoredDirectory(e.name, nextPath)) {
                    await this.scanDir(nextPath, base, depth + 1, maxDepth, showBranch, results, visited);
                }
            }
        } catch {}
    }
}

export class RepoTreeProvider implements vscode.TreeDataProvider<RepoTreeItem> {
    private _onDidChange = new vscode.EventEmitter<RepoTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private repos: GitRepository[] = [];

    constructor(private context: vscode.ExtensionContext) {}

    public setRepositories(r: GitRepository[]) { 
        this.repos = r.filter(repo => fs.existsSync(repo.path)); 
        this._onDidChange.fire(); 
    }
    public refreshTree() { 
        this.pruneMissing();
        this._onDidChange.fire(); 
    }
    public getRepositories() { return this.repos; }
    public getTreeItem(element: RepoTreeItem) { return element; }

    public pruneMissing(): GitRepository[] {
        const initialCount = this.repos.length;
        this.repos = this.repos.filter(r => fs.existsSync(r.path));
        if (this.repos.length !== initialCount) {
            this._onDidChange.fire();
            this.context.globalState.update('gitRepoManager.cachedRepos', this.repos).then(undefined, () => {});
        }
        return this.repos;
    }

    public removeRepo(repoPath: string) {
        const norm = repoPath.replace(/\\/g, '/').toLowerCase();
        const initialCount = this.repos.length;
        this.repos = this.repos.filter(r => {
            const rNorm = r.path.replace(/\\/g, '/').toLowerCase();
            return rNorm !== norm && !rNorm.startsWith(norm + '/');
        });
        if (this.repos.length !== initialCount) {
            this._onDidChange.fire();
            this.context.globalState.update('gitRepoManager.cachedRepos', this.repos).then(undefined, () => {});
        }
    }

    public getChildren(element?: RepoTreeItem): Thenable<RepoTreeItem[]> {
        if (this.repos.length === 0) {
            const searchDirs = ConfigManager.getSearchDirectories();
            if (searchDirs.length === 0) {
                return Promise.resolve([new RepoTreeItem('No search directory set. Click here to configure.', 'empty', vscode.TreeItemCollapsibleState.None)]);
            }
            return Promise.resolve([new RepoTreeItem('No Git repositories found. Click refresh.', 'empty', vscode.TreeItemCollapsibleState.None)]);
        }

        if (!element) {
            const items: RepoTreeItem[] = [];

            const activeRepos = this.repos.filter(r => !ConfigManager.isHidden(r.path, r.name));
            const hiddenRepos = this.repos.filter(r => ConfigManager.isHidden(r.path, r.name));

            const needsSync = activeRepos.filter(r => (r.behind ?? 0) > 0 || (r.ahead ?? 0) > 0 || (r.changes ?? 0) > 0 || r.syncStatus === 'dirty');
            if (needsSync.length > 0) {
                items.push(
                    new RepoTreeItem(
                        `Needs Sync (${needsSync.length})`,
                        'category',
                        vscode.TreeItemCollapsibleState.Expanded,
                        undefined,
                        needsSync.map(r => new RepoTreeItem(r.name, 'repo', vscode.TreeItemCollapsibleState.None, r, undefined, false))
                    )
                );
            }

            const favs = activeRepos.filter(r => r.isPinned);
            if (favs.length > 0) {
                items.push(
                    new RepoTreeItem(
                        `Favorites (${favs.length})`,
                        'category',
                        vscode.TreeItemCollapsibleState.Expanded,
                        undefined,
                        favs.map(r => new RepoTreeItem(r.name, 'repo', vscode.TreeItemCollapsibleState.None, r, undefined, false))
                    )
                );
            }

            const allItems = activeRepos.length > 0
                ? activeRepos.map(r => new RepoTreeItem(r.name, 'repo', vscode.TreeItemCollapsibleState.None, r, undefined, false))
                : [new RepoTreeItem('No active repositories found.', 'empty', vscode.TreeItemCollapsibleState.None)];
            items.push(new RepoTreeItem(`All Repositories (${activeRepos.length})`, 'category', vscode.TreeItemCollapsibleState.Expanded, undefined, allItems));

            if (hiddenRepos.length > 0) {
                const hiddenItems = hiddenRepos.map(r => new RepoTreeItem(r.name, 'repo', vscode.TreeItemCollapsibleState.None, r, undefined, true));
                items.push(new RepoTreeItem(`Hidden (${hiddenRepos.length})`, 'category', vscode.TreeItemCollapsibleState.Collapsed, undefined, hiddenItems));
            }

            return Promise.resolve(items);
        }
        return Promise.resolve(element.children || []);
    }
}

async function ensureInheritWindowDimensions(): Promise<void> {
    try {
        const winConfig = vscode.workspace.getConfiguration('window');
        const current = winConfig.get<string>('newWindowDimensions', 'default');
        if (!current || current === 'default') {
            await winConfig.update('newWindowDimensions', 'inherit', vscode.ConfigurationTarget.Global);
        }
    } catch {}
}

async function openProjectFolder(folderPath: string, forceNewWindow: boolean): Promise<void> {
    await ensureInheritWindowDimensions();
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folderPath), {
        forceNewWindow,
        forceReuseWindow: !forceNewWindow
    });
}

export function activateGitRepoManager(context: vscode.ExtensionContext) {
    ensureInheritWindowDimensions();

    const scanner = new RepoScanner(context);
    const commandCenter = new RepoCommandCenter(context, scanner);
    context.subscriptions.push(vscode.commands.registerCommand('gitRepoManager.openCommandCenter', () => commandCenter.open()));
    if (ConfigManager.getShowCommandCenterOnStartup()) {
        commandCenter.open();
    }
    const provider = new RepoTreeProvider(context);

    // Status bar indicator showing at-a-glance sync status for the active workspace and all tracked repos
    const syncStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    syncStatusBar.command = 'gitRepoManager.openCommandCenter';
    syncStatusBar.text = '$(sync) Checking repos...';
    syncStatusBar.tooltip = 'Open Multi-Repository Command Center';
    syncStatusBar.show();
    context.subscriptions.push(syncStatusBar);

    const updateSyncStatusBar = (repos: GitRepository[]) => {
        const active = repos.filter(r => !ConfigManager.isHidden(r.path, r.name) && r.syncStatus !== 'none');
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const normWs = wsPath ? path.resolve(wsPath).toLowerCase() : '';
        const currentRepo = normWs ? active.find(r => path.resolve(r.path).toLowerCase() === normWs) : undefined;

        const behindRepos = active.filter(r => (r.behind ?? 0) > 0);
        const aheadRepos = active.filter(r => (r.ahead ?? 0) > 0);
        const dirtyRepos = active.filter(r => (r.changes ?? 0) > 0 || r.syncStatus === 'dirty');
        const needSyncRepos = active.filter(r => (r.behind ?? 0) > 0 || (r.ahead ?? 0) > 0);

        const curBehind = currentRepo?.behind ?? 0;
        const curAhead = currentRepo?.ahead ?? 0;
        const curChanges = currentRepo?.changes ?? 0;

        if (currentRepo && (curBehind > 0 || curAhead > 0)) {
            const parts: string[] = [];
            if (curBehind > 0) parts.push(`↓${curBehind}`);
            if (curAhead > 0) parts.push(`↑${curAhead}`);
            const extra = needSyncRepos.length > 1 ? ` (+${needSyncRepos.length - 1} repos)` : '';
            syncStatusBar.text = `$(sync) Sync needed ${parts.join(' ')}${extra}`;
            syncStatusBar.backgroundColor = curBehind > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        } else if (needSyncRepos.length > 0) {
            const parts: string[] = [];
            if (behindRepos.length > 0) parts.push(`↓${behindRepos.length}`);
            if (aheadRepos.length > 0) parts.push(`↑${aheadRepos.length}`);
            syncStatusBar.text = `$(sync) ${needSyncRepos.length} repo${needSyncRepos.length === 1 ? '' : 's'} need sync (${parts.join(' ')})`;
            syncStatusBar.backgroundColor = behindRepos.length > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        } else if (currentRepo && curChanges > 0) {
            syncStatusBar.text = `$(edit) ${curChanges} uncommitted${dirtyRepos.length > 1 ? ` (+${dirtyRepos.length - 1} repos)` : ''}`;
            syncStatusBar.backgroundColor = undefined;
        } else if (dirtyRepos.length > 0) {
            syncStatusBar.text = `$(edit) ${dirtyRepos.length} repo${dirtyRepos.length === 1 ? '' : 's'} with changes`;
            syncStatusBar.backgroundColor = undefined;
        } else {
            syncStatusBar.text = `$(check) ${active.length} repo${active.length === 1 ? '' : 's'} synced`;
            syncStatusBar.backgroundColor = undefined;
        }

        const tipLines: string[] = ['**xVSGravityTools — Repository Sync Status**', ''];
        if (currentRepo) {
            const curState = curBehind || curAhead
                ? `${curBehind ? `↓${curBehind} behind` : ''}${curBehind && curAhead ? ', ' : ''}${curAhead ? `↑${curAhead} ahead` : ''}`
                : curChanges ? `${curChanges} uncommitted file(s)` : 'In sync';
            tipLines.push(`Current workspace (**${currentRepo.name}**): ${curState}`);
        }
        tipLines.push(`Tracked repositories: ${active.length} total · ${behindRepos.length} to pull · ${aheadRepos.length} to push · ${dirtyRepos.length} dirty`);
        if (needSyncRepos.length > 0) {
            tipLines.push('', '**Needs Sync:**');
            for (const r of needSyncRepos.slice(0, 8)) {
                const flags = [r.behind ? `↓${r.behind}` : '', r.ahead ? `↑${r.ahead}` : ''].filter(Boolean).join(' ');
                tipLines.push(`- ${r.name}: ${flags}`);
            }
            if (needSyncRepos.length > 8) tipLines.push(`- …and ${needSyncRepos.length - 8} more`);
        }
        tipLines.push('', '_Click to open Command Center_');
        const md = new vscode.MarkdownString(tipLines.join('\n'));
        md.isTrusted = true;
        syncStatusBar.tooltip = md;
    };

    const setReposAndUpdateBar = (repos: GitRepository[], syncCommandCenter = true) => {
        provider.setRepositories(repos);
        updateSyncStatusBar(provider.getRepositories());
        if (syncCommandCenter) {
            void commandCenter.syncFromExternalRepos(repos);
        }
    };

    commandCenter.setOnReposUpdated(repos => setReposAndUpdateBar(repos, false));

    vscode.window.createTreeView('gitRepoManagerView', { treeDataProvider: provider, showCollapseAll: true });

    setReposAndUpdateBar(scanner.getCachedRepos());
    scanner.scanRepositories().then(r => setReposAndUpdateBar(r));

    // Keep sync-status colors fresh (local git checks only, no network).
    let statusRefreshInFlight = false;
    let lastStatusRefreshAt = 0;
    const refreshStatusesSafe = async (minIntervalMs = 0) => {
        if (statusRefreshInFlight) return;
        const now = Date.now();
        if (minIntervalMs > 0 && now - lastStatusRefreshAt < minIntervalMs) return;
        statusRefreshInFlight = true;
        try {
            provider.pruneMissing();
            setReposAndUpdateBar(await scanner.refreshStatuses(provider.getRepositories()));
            lastStatusRefreshAt = Date.now();
        } finally {
            statusRefreshInFlight = false;
        }
    };

    const statusTimer = setInterval(() => {
        if (vscode.window.state.focused) {
            void refreshStatusesSafe(30000);
        }
    }, 60000);
    context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });
    context.subscriptions.push(vscode.window.onDidChangeWindowState(s => {
        if (s.focused) {
            void refreshStatusesSafe(15000);
        }
    }));

    // Automatically watch search directories for created or removed folders in Windows Explorer / OS
    let fsWatchers: fs.FSWatcher[] = [];
    let watcherDebounceTimer: NodeJS.Timeout | undefined;

    const setupWatchers = () => {
        for (const w of fsWatchers) {
            try { w.close(); } catch {}
        }
        fsWatchers = [];

        const searchDirs = ConfigManager.getSearchDirectories();
        const maxDepth = ConfigManager.getScanDepth();
        const dirsToWatch = new Set<string>();

        const collectDirsToWatch = (currDir: string, depth: number) => {
            if (!fs.existsSync(currDir)) return;
            const norm = path.normalize(currDir).toLowerCase();
            if (dirsToWatch.has(norm)) return;

            const isRootSearchDir = searchDirs.some(d => path.normalize(d).toLowerCase() === norm);
            if (!isRootSearchDir && fs.existsSync(path.join(currDir, '.git'))) {
                return;
            }

            dirsToWatch.add(currDir);

            if (depth >= maxDepth - 1) return;

            try {
                const entries = fs.readdirSync(currDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const fullSub = path.join(currDir, entry.name);
                        if (!isIgnoredDirectory(entry.name, fullSub) && !fs.existsSync(path.join(fullSub, '.git'))) {
                            collectDirsToWatch(fullSub, depth + 1);
                        }
                    }
                }
            } catch {}
        };

        for (const dir of searchDirs) {
            if (fs.existsSync(dir)) {
                collectDirsToWatch(dir, 0);
            }
        }

        for (const dirToWatch of dirsToWatch) {
            try {
                const watcher = fs.watch(dirToWatch, { recursive: false }, () => {
                    if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer);
                    watcherDebounceTimer = setTimeout(async () => {
                        provider.pruneMissing();
                        const fresh = await scanner.scanRepositories();
                        provider.setRepositories(fresh);
                    }, 1000);
                });

                watcher.on('error', (err) => {
                    console.error(`File watcher error on ${dirToWatch}:`, err);
                });

                fsWatchers.push(watcher);
            } catch (err) {
                console.error(`Failed to create file watcher for ${dirToWatch}:`, err);
            }
        }
    };

    setupWatchers();
    context.subscriptions.push({
        dispose: () => {
            if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer);
            for (const w of fsWatchers) {
                try { w.close(); } catch {}
            }
            fsWatchers = [];
        }
    });

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitRepoManager')) {
            provider.pruneMissing();
            provider.setRepositories(scanner.getCachedRepos());
            if (e.affectsConfiguration('gitRepoManager.searchDirectories')) {
                setupWatchers();
            }
        }
    }));

    context.subscriptions.push(
        vscode.commands.registerCommand('gitRepoManager.refreshTree', () => {
            provider.refreshTree();
        }),
        vscode.commands.registerCommand('gitRepoManager.createFolder', async () => {
            let searchDirs = ConfigManager.getSearchDirectories();
            if (searchDirs.length === 0) {
                const choice = await vscode.window.showInformationMessage(
                    'No root search directory is configured for Git Repo Manager.',
                    'Select Search Directory'
                );
                if (choice !== 'Select Search Directory') return;
                const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false });
                if (!uri || !uri[0]) return;
                await ConfigManager.addSearchDirectory(uri[0].fsPath);
                searchDirs = ConfigManager.getSearchDirectories();
            }

            let targetRoot = searchDirs[0];
            if (searchDirs.length > 1) {
                const pickedRoot = await vscode.window.showQuickPick(
                    searchDirs.map(dir => ({
                        label: path.basename(dir) || dir,
                        description: dir,
                        dirPath: dir
                    })),
                    { placeHolder: 'Select root directory where the new project folder should be created' }
                );
                if (!pickedRoot) return;
                targetRoot = pickedRoot.dirPath;
            }

            const folderName = await vscode.window.showInputBox({
                title: 'New Project Folder',
                prompt: `Create a new project folder in ${targetRoot}`,
                placeHolder: 'Enter new project folder name',
                validateInput: (value) => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                        return 'Folder name cannot be empty.';
                    }
                    if (trimmed === '.' || trimmed === '..') {
                        return 'Invalid folder name.';
                    }
                    if (/[<>:"/\\|?*\x00-\x1F]/.test(trimmed)) {
                        return 'Folder name contains invalid characters.';
                    }
                    const fullPath = path.join(targetRoot, trimmed);
                    if (fs.existsSync(fullPath)) {
                        return `A folder or file named "${trimmed}" already exists in ${targetRoot}.`;
                    }
                    return null;
                }
            });

            if (!folderName) return;
            const cleanName = folderName.trim();
            const newFolderPath = path.join(targetRoot, cleanName);

            try {
                await fs.promises.mkdir(newFolderPath, { recursive: true });
                provider.setRepositories(await scanner.scanRepositories());

                const action = await vscode.window.showInformationMessage(
                    `Created project folder "${cleanName}" in ${targetRoot}.`,
                    'Open Folder',
                    'Open in New Window'
                );
                if (action === 'Open Folder') {
                    await openProjectFolder(newFolderPath, false);
                } else if (action === 'Open in New Window') {
                    await openProjectFolder(newFolderPath, true);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to create folder "${cleanName}": ${err?.message || err}`);
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.selectBaseDirectory', async () => {
            const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false });
            if (uri && uri[0]) {
                await ConfigManager.addSearchDirectory(uri[0].fsPath);
                provider.setRepositories(await scanner.scanRepositories());
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.addDirectory', async () => {
            await vscode.commands.executeCommand('gitRepoManager.selectBaseDirectory');
        }),
        vscode.commands.registerCommand('gitRepoManager.refresh', async () => {
            provider.pruneMissing();

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: 'xVSGravityTools: Refreshing repositories...'
                },
                async () => {
                    try {
                        const freshRepos = await scanner.scanRepositories();
                        setReposAndUpdateBar(freshRepos);
                    } catch (err: any) {
                        console.error('Error refreshing repositories:', err);
                    }
                }
            );
        }),
        vscode.commands.registerCommand('gitRepoManager.fetchAll', async () => {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'xVSGravityTools: Checking remotes'
                },
                async (progress) => {
                    try {
                        const current = provider.getRepositories();
                        let lastPct = 0;
                        const { fetched, failed } = await scanner.fetchAllRepositories(current, (done, total, repoName) => {
                            if (total <= 0) return;
                            const pct = Math.round((done / total) * 90);
                            const inc = Math.max(0, pct - lastPct);
                            lastPct = pct;
                            progress.report({
                                increment: inc,
                                message: repoName ? `${done}/${total} · ${repoName}` : `Fetching ${total} repositories...`
                            });
                        });
                        progress.report({ increment: Math.max(0, 95 - lastPct), message: 'Updating repository statuses...' });
                        const refreshed = await scanner.refreshStatuses(current);
                        setReposAndUpdateBar(refreshed);
                        progress.report({ increment: 5, message: 'Done' });
                        const behindCount = refreshed.filter(r => (r.behind ?? 0) > 0).length;
                        const aheadCount = refreshed.filter(r => (r.ahead ?? 0) > 0).length;
                        const msg = behindCount || aheadCount
                            ? `Checked ${fetched} remote(s): ${behindCount} behind, ${aheadCount} ahead.${failed ? ` (${failed} failed)` : ''}`
                            : `Checked ${fetched} remote(s): all tracked repositories are up to date.${failed ? ` (${failed} failed)` : ''}`;
                        vscode.window.showInformationMessage(msg);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to fetch remotes: ${err?.message || err}`);
                    }
                }
            );
        }),
        vscode.commands.registerCommand('gitRepoManager.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'gitRepoManager');
        }),
        vscode.commands.registerCommand('gitRepoManager.openQuickPick', async () => {
            provider.pruneMissing();
            const allRepos = provider.getRepositories();
            const activeRepos = allRepos.filter(r => !ConfigManager.isHidden(r.path, r.name));
            const hiddenRepos = allRepos.filter(r => ConfigManager.isHidden(r.path, r.name));
            const items: Array<{ label: string; description: string; repo?: GitRepository; isCreateNew?: boolean; isBrowseHidden?: boolean }> = [
                {
                    label: '$(new-folder) New Project Folder...',
                    description: 'Create a new folder in your projects root directory',
                    isCreateNew: true
                },
                ...activeRepos.map(r => {
                    const vis = VISIBILITY_LABEL[r.visibility ?? 'local'];
                    return {
                        label: r.name,
                        description: `${vis}${r.branch ? ` • ${r.branch}` : ''} — ${r.path}`,
                        repo: r
                    };
                })
            ];

            if (hiddenRepos.length > 0) {
                items.push({
                    label: `$(eye-closed) Browse Hidden Repositories... (${hiddenRepos.length})`,
                    description: 'Open a hidden or excluded repository',
                    isBrowseHidden: true
                });
            }

            const picked = await vscode.window.showQuickPick(
                items,
                { placeHolder: 'Select repository to open or create a new project folder' }
            );
            if (picked?.isCreateNew) {
                await vscode.commands.executeCommand('gitRepoManager.createFolder');
            } else if (picked?.isBrowseHidden) {
                const hiddenPicked = await vscode.window.showQuickPick(
                    hiddenRepos.map(r => {
                        const vis = VISIBILITY_LABEL[r.visibility ?? 'local'];
                        return {
                            label: `$(eye-closed) ${r.name}`,
                            description: `[Hidden] • ${vis}${r.branch ? ` • ${r.branch}` : ''} — ${r.path}`,
                            repo: r
                        };
                    }),
                    { placeHolder: 'Select hidden repository to open' }
                );
                if (hiddenPicked?.repo) {
                    await openProjectFolder(hiddenPicked.repo.path, ConfigManager.getOpenInNewWindow());
                }
            } else if (picked?.repo) {
                await openProjectFolder(picked.repo.path, ConfigManager.getOpenInNewWindow());
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.handleTreeItemClick', async (repo: GitRepository) => {
            if (repo) {
                await openProjectFolder(repo.path, ConfigManager.getOpenInNewWindow());
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.openRepoCurrentWindow', async (item: any) => {
            const repo = item?.repo || item;
            if (repo) await openProjectFolder(repo.path, false);
        }),
        vscode.commands.registerCommand('gitRepoManager.openRepoNewWindow', async (item: any) => {
            const repo = item?.repo || item;
            if (repo) await openProjectFolder(repo.path, true);
        }),
        vscode.commands.registerCommand('gitRepoManager.pinRepo', async (item: any) => {
            if (item?.repo) {
                await ConfigManager.toggleFavorite(item.repo.path);
                provider.setRepositories(scanner.getCachedRepos());
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.unpinRepo', async (item: any) => {
            if (item?.repo) {
                await ConfigManager.toggleFavorite(item.repo.path);
                provider.setRepositories(scanner.getCachedRepos());
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.hideRepo', async (item?: any) => {
            let targetRepo: GitRepository | undefined = item?.repo || (item?.path ? item : undefined);
            if (!targetRepo) {
                const activeRepos = provider.getRepositories().filter(r => !ConfigManager.isHidden(r.path, r.name));
                if (activeRepos.length === 0) {
                    vscode.window.showInformationMessage('No active repositories to hide.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    activeRepos.map(r => ({
                        label: r.name,
                        description: r.path,
                        repo: r
                    })),
                    { placeHolder: 'Select repository to hide from active projects' }
                );
                if (!picked) return;
                targetRepo = picked.repo;
            }
            if (targetRepo?.path) {
                await ConfigManager.hideRepo(targetRepo.path);
                provider.setRepositories(scanner.getCachedRepos());
                vscode.window.showInformationMessage(`Hidden "${targetRepo.name}" from active projects.`);
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.unhideRepo', async (item?: any) => {
            let targetRepo: GitRepository | undefined = item?.repo || (item?.path ? item : undefined);
            if (!targetRepo) {
                const hiddenRepos = provider.getRepositories().filter(r => ConfigManager.isHidden(r.path, r.name));
                if (hiddenRepos.length === 0) {
                    vscode.window.showInformationMessage('No hidden repositories to unhide.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    hiddenRepos.map(r => ({
                        label: r.name,
                        description: r.path,
                        repo: r
                    })),
                    { placeHolder: 'Select repository to unhide' }
                );
                if (!picked) return;
                targetRepo = picked.repo;
            }
            if (targetRepo?.path) {
                await ConfigManager.unhideRepo(targetRepo.path, targetRepo.name);
                provider.setRepositories(scanner.getCachedRepos());
                vscode.window.showInformationMessage(`Restored "${targetRepo.name}" to active projects.`);
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.revealInExplorer', async (item: any) => {
            const repo = item?.repo || item;
            if (repo?.path) {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repo.path));
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.openInTerminal', async (item: any) => {
            const repo = item?.repo || item;
            if (repo?.path) {
                vscode.window.createTerminal({ name: repo.name, cwd: repo.path }).show();
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.copyPath', async (item: any) => {
            const repo = item?.repo || item;
            if (repo?.path) {
                await vscode.env.clipboard.writeText(repo.path);
                vscode.window.showInformationMessage(`Copied: ${repo.path}`);
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.syncRepo', async (item: any) => {
            const repo = item?.repo || (item?.path ? item : undefined);
            if (repo?.path) {
                await commandCenter.syncByPath(repo.path);
            }
        }),
        vscode.commands.registerCommand('gitRepoManager.deleteRepo', async (item?: any) => {
            let targetRepo: GitRepository | undefined = item?.repo || (item?.path ? item : undefined);
            if (!targetRepo) {
                const allRepos = provider.getRepositories();
                if (allRepos.length === 0) {
                    vscode.window.showInformationMessage('No repositories available to delete.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    allRepos.map(r => ({
                        label: r.name,
                        description: r.path,
                        repo: r
                    })),
                    { placeHolder: 'Select project repository to delete (move to Recycle Bin)' }
                );
                if (!picked) return;
                targetRepo = picked.repo;
            }

            if (!targetRepo?.path) return;

            const repoPath = targetRepo.path;
            const repoName = targetRepo.name;

            if (!fs.existsSync(repoPath)) {
                vscode.window.showErrorMessage(`Project folder does not exist: ${repoPath}`);
                provider.removeRepo(repoPath);
                provider.pruneMissing();
                return;
            }

            const isWorkspaceFolder = vscode.workspace.workspaceFolders?.some(wf => {
                const wfPath = wf.uri.fsPath.replace(/\\/g, '/').toLowerCase();
                const rPath = repoPath.replace(/\\/g, '/').toLowerCase();
                return wfPath === rPath || wfPath.startsWith(rPath + '/') || rPath.startsWith(wfPath + '/');
            });

            const warningMsg = isWorkspaceFolder
                ? `"${repoName}" is currently open in your active VS Code workspace.\n\nAre you sure you want to delete this project folder and move it to the Recycle Bin?\n\nPath: ${repoPath}`
                : `Are you sure you want to delete the project folder "${repoName}"?\n\nThis will move it to the Recycle Bin:\n${repoPath}`;

            const choice = await vscode.window.showWarningMessage(
                warningMsg,
                { modal: true },
                'Move to Recycle Bin'
            );

            if (choice !== 'Move to Recycle Bin') {
                return;
            }

            try {
                provider.removeRepo(repoPath);

                await vscode.workspace.fs.delete(vscode.Uri.file(repoPath), { recursive: true, useTrash: true });

                if (ConfigManager.isFavorite(repoPath)) {
                    await ConfigManager.toggleFavorite(repoPath);
                }
                if (ConfigManager.isHidden(repoPath, repoName)) {
                    await ConfigManager.unhideRepo(repoPath, repoName);
                }

                const freshRepos = await scanner.scanRepositories();
                provider.setRepositories(freshRepos);

                vscode.window.showInformationMessage(`Moved project "${repoName}" to the Recycle Bin.`);
            } catch (err: any) {
                const freshRepos = await scanner.scanRepositories();
                provider.setRepositories(freshRepos);
                vscode.window.showErrorMessage(`Failed to move "${repoName}" to Recycle Bin: ${err?.message || err}`);
            }
        })
    );
}
