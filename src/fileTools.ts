import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execFile, spawn } from 'child_process';

let textPreviewServer: http.Server | undefined;
const textPreviewFiles = new Map<string, string>();

export function activateFileTools(context: vscode.ExtensionContext) {
    context.subscriptions.push({
        dispose: () => {
            textPreviewServer?.close();
            textPreviewServer = undefined;
            textPreviewFiles.clear();
        }
    });
    context.subscriptions.push(
        vscode.commands.registerCommand('fileTools.copyFileContents', async (uri?: vscode.Uri) => {
            await copyFileContents(uri);
        }),
        vscode.commands.registerCommand('fileTools.openAsTextInChrome', async (uri?: vscode.Uri) => {
            await openAsTextInChrome(uri);
        }),
        vscode.commands.registerCommand('fileTools.copyPath', async (uri?: vscode.Uri) => {
            await copyPath(uri);
        }),
        vscode.commands.registerCommand('fileTools.copyFileHash', async (uri?: vscode.Uri) => {
            await copyFileHash(uri);
        }),
        vscode.commands.registerCommand('fileTools.showMetadata', async (uri?: vscode.Uri) => {
            await showFileMetadata(uri);
        }),
        vscode.commands.registerCommand('fileTools.alphabetizeLines', async (uri?: vscode.Uri) => {
            await alphabetizeLines(uri);
        }),
        vscode.commands.registerCommand('fileTools.deduplicateLines', async (uri?: vscode.Uri) => {
            await deduplicateLines(uri);
        }),
        vscode.commands.registerCommand('fileTools.addToPath', async (uri?: vscode.Uri) => {
            await addToPath(uri);
        })
    );
}

/** Serves a file as plain text from localhost so Chrome displays its contents, including HTML and scripts. */
async function openAsTextInChrome(uri?: vscode.Uri): Promise<void> {
    const targetUri = resolveTargetUri(uri);
    if (!targetUri) {
        vscode.window.showWarningMessage('Select or open a local file to view as text in Chrome.');
        return;
    }

    try {
        const stat = await vscode.workspace.fs.stat(targetUri);
        if (stat.type & vscode.FileType.Directory) {
            vscode.window.showWarningMessage('Select a file to view as text in Chrome.');
            return;
        }
        const previewId = crypto.randomBytes(16).toString('hex');
        textPreviewFiles.set(previewId, targetUri.fsPath);
        if (!textPreviewServer || !textPreviewServer.listening) {
            textPreviewServer = http.createServer((req, res) => {
                const currentFile = textPreviewFiles.get((req.url || '').slice(1));
                if (!currentFile) {
                    res.writeHead(404).end('Not Found');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Disposition': 'inline',
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'no-store'
                });
                const stream = fs.createReadStream(currentFile);
                stream.on('error', () => {
                    if (!res.headersSent) res.writeHead(404);
                    res.end('Could not read file.');
                });
                stream.pipe(res);
            });
            await new Promise<void>((resolve, reject) => {
                textPreviewServer!.once('error', reject);
                textPreviewServer!.listen(0, '127.0.0.1', resolve);
            });
        }
        const address = textPreviewServer.address();
        if (!address || typeof address === 'string') throw new Error('Could not start the text preview server.');
        const url = `http://127.0.0.1:${address.port}/${previewId}`;
        const chrome = getChromeCommand();
        const child = spawn(chrome.command, [...chrome.args, url], { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', error => vscode.window.showErrorMessage(`Could not launch Chrome: ${error.message}`));
        child.unref();
    } catch (err: any) {
        vscode.window.showErrorMessage(`Could not open file as text in Chrome: ${err.message}`);
    }
}

function getChromeCommand(): { command: string; args: string[] } {
    if (process.platform === 'win32') {
        const candidates = [
            path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
        ];
        return { command: candidates.find(candidate => fs.existsSync(candidate)) || 'chrome', args: [] };
    }
    if (process.platform === 'darwin') {
        return { command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: [] };
    }
    return { command: 'google-chrome', args: [] };
}

/** Adds the selected folder (or selected file's parent) to a Windows PATH. */
async function addToPath(uri?: vscode.Uri): Promise<void> {
    if (process.platform !== 'win32') {
        vscode.window.showWarningMessage('Add to PATH is currently available on Windows only.');
        return;
    }
    const targetUri = resolveTargetUri(uri);
    const target = targetUri ? (await vscode.workspace.fs.stat(targetUri)).type & vscode.FileType.Directory
        ? targetUri.fsPath : path.dirname(targetUri.fsPath)
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!target) {
        vscode.window.showWarningMessage('Select a folder or open a workspace to add to PATH.');
        return;
    }

    const scope = await vscode.window.showQuickPick([
        { label: 'User PATH', value: 'User' as const, description: 'Available to your Windows account' },
        { label: 'System PATH', value: 'Machine' as const, description: 'Available to all users; may require administrator rights' }
    ], { placeHolder: 'Choose which PATH to update' });
    if (!scope) return;
    const confirmed = await vscode.window.showWarningMessage(
        `Add "${target}" to the ${scope.label}?`, { modal: true }, 'Add to PATH'
    );
    if (confirmed !== 'Add to PATH') return;

    const encodedPath = Buffer.from(target, 'utf16le').toString('base64');
    const updateScript = `$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $scope = '${scope.value}'; $current = [Environment]::GetEnvironmentVariable('Path', $scope); $entries = @($current -split ';' | Where-Object { $_ }); $alreadyPresent = [bool]($entries | Where-Object { $_.TrimEnd('\\') -ieq $target.TrimEnd('\\') }); if ($alreadyPresent) { Write-Output 'ALREADY_PRESENT' } else { $value = (@($entries) + $target) -join ';'; [Environment]::SetEnvironmentVariable('Path', $value, $scope) }`;

    if (scope.value === 'Machine') {
        // Only the helper process is elevated; VS Code remains unelevated.
        const elevatedScript = `Add-Type -AssemblyName PresentationFramework; try { ${updateScript}; if ($alreadyPresent) { [System.Windows.MessageBox]::Show('That folder is already in the system PATH.', 'xVSGravityTools') | Out-Null } else { Add-Type -Namespace Native -Name EnvBroadcast -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'; [UIntPtr]$result = [UIntPtr]::Zero; [Native.EnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null; [System.Windows.MessageBox]::Show('System PATH updated. New processes will use the updated PATH.', 'xVSGravityTools') | Out-Null } } catch { [System.Windows.MessageBox]::Show($_.Exception.Message, 'Could not update system PATH') | Out-Null; exit 1 }`;
        const encodedScript = Buffer.from(elevatedScript, 'utf16le').toString('base64');
        const launchScript = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-EncodedCommand','${encodedScript}')`;
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launchScript], { windowsHide: true }, error => {
            if (error) vscode.window.showInformationMessage('The elevated PATH helper was not started. The UAC request may have been cancelled.');
            else vscode.window.showInformationMessage('Confirm the UAC prompt to update the system PATH.');
        });
        return;
    }

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', updateScript], { windowsHide: true }, (error, stdout, stderr) => {
        if (!error) {
            vscode.window.showInformationMessage(stdout.includes('ALREADY_PRESENT')
                ? `"${target}" is already in the ${scope.label}.`
                : `Added "${target}" to the ${scope.label}. New terminals will use the updated PATH.`);
        } else if ((error as NodeJS.ErrnoException & { code?: number }).code === 3) {
            vscode.window.showInformationMessage(`"${target}" is already in the ${scope.label}.`);
        } else {
            vscode.window.showErrorMessage(`Could not update the ${scope.label}: ${stderr || error.message}`);
        }
    });
}

/** Copies the selected file's absolute path, or the active file's path, to the clipboard. */
async function copyPath(uri?: vscode.Uri): Promise<void> {
    const targetUri = resolveTargetUri(uri);
    if (!targetUri) {
        vscode.window.showWarningMessage('Select a file to copy its path.');
        return;
    }

    await vscode.env.clipboard.writeText(targetUri.fsPath);
    vscode.window.showInformationMessage(`Copied path: ${targetUri.fsPath}`);
}

/** Shows basic filesystem metadata for a selected file or the active editor's file. */
async function showFileMetadata(uri?: vscode.Uri): Promise<void> {
    const targetUri = resolveTargetUri(uri);
    if (!targetUri) {
        vscode.window.showWarningMessage('Select a file to view its metadata.');
        return;
    }

    try {
        const stat = await vscode.workspace.fs.stat(targetUri);
        const fileName = path.basename(targetUri.fsPath);
        const kind = stat.type & vscode.FileType.Directory ? 'Directory' : 'File';
        const details = [
            `Name: ${fileName}`,
            `Type: ${kind}`,
            `Path: ${targetUri.fsPath}`,
            `Size: ${formatBytes(stat.size)} (${stat.size} bytes)`,
            `Created: ${new Date(stat.ctime).toLocaleString()}`,
            `Modified: ${new Date(stat.mtime).toLocaleString()}`
        ];
        const channel = vscode.window.createOutputChannel('xVSGravityTools: File Metadata');
        channel.clear();
        channel.appendLine(details.join('\n'));
        channel.show(true);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to read file metadata: ${err.message}`);
    }
}

function resolveTargetUri(uri?: vscode.Uri): vscode.Uri | undefined {
    if (uri && uri.scheme === 'file') {
        return uri;
    }
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
        return activeEditor.document.uri;
    }
    return undefined;
}

/**
 * Copies the raw text content of the target file directly to the clipboard.
 */
async function copyFileContents(uri?: vscode.Uri): Promise<void> {
    const targetUri = resolveTargetUri(uri);
    if (!targetUri) {
        vscode.window.showWarningMessage('No file selected to copy contents.');
        return;
    }

    try {
        const fileStat = await vscode.workspace.fs.stat(targetUri);
        const MAX_SIZE = 10 * 1024 * 1024; // 10MB limit warning
        if (fileStat.size > MAX_SIZE) {
            const confirm = await vscode.window.showWarningMessage(
                `File size is large (${formatBytes(fileStat.size)}). Copying to clipboard may impact performance. Continue?`,
                { modal: true },
                'Copy Anyway'
            );
            if (confirm !== 'Copy Anyway') return;
        }

        const uint8Array = await vscode.workspace.fs.readFile(targetUri);
        const content = Buffer.from(uint8Array).toString('utf-8');
        await vscode.env.clipboard.writeText(content);

        const lineCount = content.split(/\r?\n/).length;
        const fileName = path.basename(targetUri.fsPath);
        vscode.window.showInformationMessage(
            `📋 Copied contents of "${fileName}" (${lineCount} lines, ${formatBytes(fileStat.size)}) to clipboard.`
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to copy file contents: ${err.message}`);
    }
}

/**
 * Calculates SHA-256, SHA-1, and MD5 cryptographic hashes of the target file,
 * copies the SHA-256 hash to the clipboard, and offers options to copy other hashes.
 */
async function copyFileHash(uri?: vscode.Uri): Promise<void> {
    const targetUri = resolveTargetUri(uri);
    if (!targetUri) {
        vscode.window.showWarningMessage('No file selected to calculate hash.');
        return;
    }

    try {
        const uint8Array = await vscode.workspace.fs.readFile(targetUri);
        const buffer = Buffer.from(uint8Array);

        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
        const md5 = crypto.createHash('md5').update(buffer).digest('hex');

        await vscode.env.clipboard.writeText(sha256);
        const fileName = path.basename(targetUri.fsPath);

        const choice = await vscode.window.showInformationMessage(
            `SHA-256 copied: ${sha256.substring(0, 16)}... ("${fileName}")`,
            'Copy MD5',
            'Copy SHA-1',
            'View All Hashes'
        );

        if (choice === 'Copy MD5') {
            await vscode.env.clipboard.writeText(md5);
            vscode.window.showInformationMessage(`Copied MD5 to clipboard: ${md5}`);
        } else if (choice === 'Copy SHA-1') {
            await vscode.env.clipboard.writeText(sha1);
            vscode.window.showInformationMessage(`Copied SHA-1 to clipboard: ${sha1}`);
        } else if (choice === 'View All Hashes') {
            const channel = vscode.window.createOutputChannel('xVSGravityTools: File Hashes');
            channel.clear();
            channel.appendLine(`File: ${targetUri.fsPath}`);
            channel.appendLine(`Size: ${formatBytes(buffer.length)} (${buffer.length} bytes)`);
            channel.appendLine(`Date: ${new Date().toLocaleString()}`);
            channel.appendLine(`----------------------------------------------------------------`);
            channel.appendLine(`MD5:     ${md5}`);
            channel.appendLine(`SHA-1:   ${sha1}`);
            channel.appendLine(`SHA-256: ${sha256}`);
            channel.appendLine(`----------------------------------------------------------------`);
            channel.show();
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to calculate file hash: ${err.message}`);
    }
}

/**
 * Alphabetizes lines in the active text selection or entire document.
 */
async function alphabetizeLines(uri?: vscode.Uri): Promise<void> {
    let editor = vscode.window.activeTextEditor;
    if (uri && (!editor || editor.document.uri.toString() !== uri.toString())) {
        const doc = await vscode.workspace.openTextDocument(uri);
        editor = await vscode.window.showTextDocument(doc);
    }

    if (!editor) {
        vscode.window.showWarningMessage('Open a text file to alphabetize lines.');
        return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const isSelection = !selection.isEmpty;

    const sortOptions = [
        { label: '$(sort-asc) Ascending (A to Z)', id: 'asc', detail: 'Case-insensitive alphabetical sort' },
        { label: '$(sort-desc) Descending (Z to A)', id: 'desc', detail: 'Reverse case-insensitive sort' },
        { label: '$(case-sensitive) Case-Sensitive (A-Z, then a-z)', id: 'case-asc', detail: 'Uppercase before lowercase' },
        { label: '$(list-ordered) Natural Sort (1, 2, 10)', id: 'natural', detail: 'Sorts multi-digit numbers numerically' }
    ];

    const pick = await vscode.window.showQuickPick(sortOptions, {
        placeHolder: `Select sort order for ${isSelection ? 'selected lines' : 'entire document'}`
    });

    if (!pick) return;

    let targetRange: vscode.Range;
    let lines: string[];

    if (isSelection) {
        const startLine = selection.start.line;
        const endLine = selection.end.line;
        targetRange = new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, document.lineAt(endLine).text.length)
        );
        lines = document.getText(targetRange).split(/\r?\n/);
    } else {
        const lastLine = document.lineAt(document.lineCount - 1);
        targetRange = new vscode.Range(
            new vscode.Position(0, 0),
            lastLine.range.end
        );
        lines = document.getText().split(/\r?\n/);
    }

    if (lines.length <= 1) {
        vscode.window.showInformationMessage('Not enough lines to sort.');
        return;
    }

    // Sort lines
    const sorted = [...lines].sort((a, b) => {
        switch (pick.id) {
            case 'desc':
                return b.localeCompare(a, undefined, { sensitivity: 'accent' });
            case 'case-asc':
                return a.localeCompare(b, undefined, { sensitivity: 'variant' });
            case 'natural':
                return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            case 'asc':
            default:
                return a.localeCompare(b, undefined, { sensitivity: 'accent' });
        }
    });

    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const newContent = sorted.join(eol);

    await editor.edit(editBuilder => {
        editBuilder.replace(targetRange, newContent);
    });

    vscode.window.showInformationMessage(`Alphabetized ${lines.length} lines (${pick.label.replace(/\$\([^)]+\)\s*/, '')}).`);
}

/**
 * Removes duplicate lines from the selection or entire document, preserving first occurrence order.
 */
async function deduplicateLines(uri?: vscode.Uri): Promise<void> {
    let editor = vscode.window.activeTextEditor;
    if (uri && (!editor || editor.document.uri.toString() !== uri.toString())) {
        const doc = await vscode.workspace.openTextDocument(uri);
        editor = await vscode.window.showTextDocument(doc);
    }

    if (!editor) {
        vscode.window.showWarningMessage('Open a text file to remove duplicate lines.');
        return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const isSelection = !selection.isEmpty;

    const modeOptions = [
        { label: 'Exact Match', id: 'exact', detail: 'Lines must match exactly, including indentation and casing' },
        { label: 'Case-Insensitive Match', id: 'case-insensitive', detail: 'Ignore casing differences when detecting duplicates' },
        { label: 'Trimmed Match', id: 'trimmed', detail: 'Ignore leading and trailing whitespace' }
    ];

    const pick = await vscode.window.showQuickPick(modeOptions, {
        placeHolder: `Select deduplication mode for ${isSelection ? 'selected lines' : 'entire document'}`
    });

    if (!pick) return;

    let targetRange: vscode.Range;
    let lines: string[];

    if (isSelection) {
        const startLine = selection.start.line;
        const endLine = selection.end.line;
        targetRange = new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, document.lineAt(endLine).text.length)
        );
        lines = document.getText(targetRange).split(/\r?\n/);
    } else {
        const lastLine = document.lineAt(document.lineCount - 1);
        targetRange = new vscode.Range(
            new vscode.Position(0, 0),
            lastLine.range.end
        );
        lines = document.getText().split(/\r?\n/);
    }

    const seen = new Set<string>();
    const uniqueLines: string[] = [];

    for (const line of lines) {
        let key = line;
        if (pick.id === 'case-insensitive') {
            key = line.toLowerCase();
        } else if (pick.id === 'trimmed') {
            key = line.trim();
        }

        if (!seen.has(key)) {
            seen.add(key);
            uniqueLines.push(line);
        }
    }

    const removedCount = lines.length - uniqueLines.length;

    if (removedCount === 0) {
        vscode.window.showInformationMessage('No duplicate lines found.');
        return;
    }

    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const newContent = uniqueLines.join(eol);

    await editor.edit(editBuilder => {
        editBuilder.replace(targetRange, newContent);
    });

    vscode.window.showInformationMessage(
        `✅ Removed ${removedCount} duplicate line(s). (${uniqueLines.length} unique lines remaining)`
    );
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

