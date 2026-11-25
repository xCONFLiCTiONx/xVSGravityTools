import * as vscode from 'vscode';
import { FileDiff, DiffAnalyzer } from './diffAnalyzer';
import { execGit } from '../gitProcess';

export interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  state: { indexChanges: any[]; workingTreeChanges: any[] };
}

export class GitService {
  private async execGit(args: string[], cwd: string): Promise<string> {
    try {
      const stdout = await execGit(args, { cwd, maxBuffer: 50 * 1024 * 1024, timeoutMs: 30000 });
      return stdout || '';
    } catch (err: any) {
      return err?.stdout || '';
    }
  }

  public async getRepository(sourceControlUri?: vscode.Uri): Promise<GitRepository | undefined> {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) return undefined;
    if (!gitExtension.isActive) await gitExtension.activate();
    const gitApi = gitExtension.exports.getAPI(1);
    const repositories: GitRepository[] = gitApi.repositories;
    if (repositories.length === 0) return undefined;
    if (sourceControlUri) {
      const matched = repositories.find(r => r.rootUri.fsPath === sourceControlUri.fsPath);
      if (matched) return matched;
    }
    return repositories[0];
  }

  public async getGitignoreWarnings(repo: GitRepository): Promise<string[]> {
    const cwd = repo.rootUri.fsPath;
    const warnings: string[] = [];
    const status = await this.execGit(['status', '--porcelain', '--', '.gitignore'], cwd);
    if (status.trim()) warnings.push('.gitignore has uncommitted changes or is untracked.');

    const staged = await this.execGit(['diff', '--cached', '--name-only', '--diff-filter=ACM'], cwd);
    const stagedPaths = staged.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    for (const file of stagedPaths) {
      const ignored = await this.execGit(['check-ignore', '--cached', '-v', '--', file], cwd);
      if (ignored.trim()) {
        warnings.push(`Staged file "${file}" matches an ignore rule.`);
      }
    }
    return warnings;
  }

  public async getDiff(
    repo: GitRepository,
    fallbackToUnstaged: boolean,
    autoStageIfNone: boolean = false
  ): Promise<{ fileDiffs: FileDiff[]; isStaged: boolean }> {
    const cwd = repo.rootUri.fsPath;
    try {
      const stagedRaw = await this.execGit(['diff', '--cached'], cwd);
      if (stagedRaw && stagedRaw.trim().length > 0) {
        const parsed = DiffAnalyzer.parseDiff(stagedRaw);
        if (parsed.length > 0) return { fileDiffs: parsed, isStaged: true };
      }
    } catch {}

    if (autoStageIfNone) {
      try {
        await this.execGit(['add', '-A'], cwd);
        const stagedRaw = await this.execGit(['diff', '--cached'], cwd);
        if (stagedRaw && stagedRaw.trim().length > 0) {
          const parsed = DiffAnalyzer.parseDiff(stagedRaw);
          if (parsed.length > 0) return { fileDiffs: parsed, isStaged: true };
        }
      } catch {}
    }

    if (fallbackToUnstaged) {
      try {
        const unstagedRaw = await this.execGit(['diff'], cwd);
        const parsed = unstagedRaw && unstagedRaw.trim().length > 0
          ? DiffAnalyzer.parseDiff(unstagedRaw)
          : [];

        // Also include untracked files so brand-new un-staged files are summarized
        const untrackedOut = await this.execGit(['ls-files', '--others', '--exclude-standard'], cwd);
        const untrackedFiles = untrackedOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        for (const relPath of untrackedFiles) {
          parsed.push({
            oldPath: relPath,
            newPath: relPath,
            status: 'added',
            addedLines: [],
            deletedLines: []
          });
        }

        if (parsed.length > 0) return { fileDiffs: parsed, isStaged: false };
      } catch {}
    }
    return { fileDiffs: [], isStaged: false };
  }

  public setCommitMessage(repo: GitRepository, message: string): void {
    repo.inputBox.value = message;
  }
}
