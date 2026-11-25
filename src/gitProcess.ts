import { ChildProcess, execFile, spawn } from 'child_process';
import * as vscode from 'vscode';

/**
 * Tracks ONLY git.exe child processes spawned directly by xVSGravityTools.
 * Never touches external git processes in user terminals, other extensions, or the IDE.
 */
const ownedGitProcesses = new Set<ChildProcess>();

function terminateOwnedProcess(child: ChildProcess): void {
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const pid = child.pid;
    try {
        if (process.platform === 'win32' && typeof pid === 'number' && pid > 0) {
            // Kill only this exact owned git process and any helper child it spawned (e.g. git-remote-https/ssh)
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
                // ignore if already exited
            });
        } else {
            child.kill('SIGTERM');
            setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    try { child.kill('SIGKILL'); } catch {}
                }
            }, 1500).unref();
        }
    } catch {
        // ignore if already exited
    }
}

export interface ExecGitOptions {
    cwd?: string;
    timeoutMs?: number;
    maxBuffer?: number;
    noOptionalLocks?: boolean;
}

/**
 * Runs a git command owned by xVSGravityTools, disables fsmonitor daemon spawning,
 * closes stdin so it never hangs on prompts, enforces timeout cleanup, and
 * tracks the child process so it is cleanly terminated if the extension deactivates.
 */
export function execGit(args: string[], options: ExecGitOptions = {}): Promise<string> {
    const {
        cwd,
        timeoutMs = 30000,
        maxBuffer = 10 * 1024 * 1024,
        noOptionalLocks = false
    } = options;

    const finalArgs = [
        ...(noOptionalLocks ? ['--no-optional-locks'] : []),
        '-c', 'core.fsmonitor=false',
        ...args
    ];

    return new Promise((resolve, reject) => {
        const child = spawn('git', finalArgs, {
            cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        ownedGitProcesses.add(child);

        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let timedOut = false;

        const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            ownedGitProcesses.delete(child);
            if (err) {
                const richErr = err as Error & { stdout?: string; stderr?: string };
                richErr.stdout = stdout;
                richErr.stderr = stderr;
                reject(richErr);
            } else {
                resolve(stdout);
            }
        };

        const timer = timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                terminateOwnedProcess(child);
                finish(new Error(`git ${args[0] || ''} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
            : undefined;

        child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes <= maxBuffer) {
                stdout += chunk.toString('utf8');
            } else {
                terminateOwnedProcess(child);
                finish(new Error('git stdout exceeded maxBuffer'));
            }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= maxBuffer) {
                stderr += chunk.toString('utf8');
            }
        });

        child.once('error', err => finish(err));
        child.once('close', (code, signal) => {
            if (timedOut) return;
            if (code === 0) {
                finish();
            } else {
                const detail = (stderr || stdout || `git exited with ${signal ? `signal ${signal}` : `code ${code}`}`).trim();
                finish(new Error(detail));
            }
        });
    });
}

/**
 * Runs a git command while streaming output to an OutputChannel, with full ownership tracking.
 */
export function spawnGitWithOutput(
    cwd: string,
    args: string[],
    output: vscode.OutputChannel,
    timeoutMs = 120000
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], {
            cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        ownedGitProcesses.add(child);

        let settled = false;
        const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            ownedGitProcesses.delete(child);
            if (err) reject(err);
            else resolve();
        };

        const timer = timeoutMs > 0
            ? setTimeout(() => {
                terminateOwnedProcess(child);
                finish(new Error(`git ${args[0] || ''} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
            : undefined;

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', chunk => output.append(String(chunk)));
        child.stderr?.on('data', chunk => output.append(String(chunk)));
        child.once('error', err => finish(err));
        child.once('close', (code, signal) => {
            if (code === 0) finish();
            else finish(new Error(`git exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
        });
    });
}

/**
 * Terminates ONLY git.exe processes still running that were spawned by xVSGravityTools.
 * Safe to call on extension deactivation / IDE shutdown without affecting user terminals or other tools.
 */
export function disposeAllOwnedGitProcesses(): void {
    for (const child of Array.from(ownedGitProcesses)) {
        terminateOwnedProcess(child);
        ownedGitProcesses.delete(child);
    }
}
