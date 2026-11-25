import * as vscode from 'vscode';
import { activateScriptRunner } from './scriptRunner';
import { activateGitManagement } from './gitManagement';
import { activateGitRepoManager } from './gitRepoManager';
import { activateHtmlDebugger } from './htmlDebugger';
import { activateSmartCommit } from './smartCommit';
import { activateFileTools } from './fileTools';
import { activateSystemTools } from './systemTools';
import { auditGlobalGitConfig } from './globalGitConfig';
import { activateXServerRemote } from './xServerRemote';
import { activateExtensionUpdates } from './extensionUpdates';
import { disposeAllOwnedGitProcesses } from './gitProcess';

export function activate(context: vscode.ExtensionContext) {
    console.log('xVSGravityTools is now active.');

    context.subscriptions.push({ dispose: () => disposeAllOwnedGitProcesses() });

    activateExtensionUpdates(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('git-management.auditGlobalConfig', auditGlobalGitConfig)
    );

    activateScriptRunner(context);
    activateGitManagement(context);
    activateXServerRemote(context);
    activateGitRepoManager(context);
    activateHtmlDebugger(context);
    activateSmartCommit(context);
    activateFileTools(context);
    activateSystemTools(context);
}

export async function deactivate() {
    disposeAllOwnedGitProcesses();
}
