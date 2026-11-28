import * as vscode from 'vscode';
import { GitService } from './gitService';
import { DiffAnalyzer } from './diffAnalyzer';
import { generateWithOllama, setOllamaSecretStorage } from './ollamaClient';
import { registerOllamaManagement } from './ollamaManagement';

export function activateSmartCommit(context: vscode.ExtensionContext) {
  const gitService = new GitService();
  setOllamaSecretStorage(context.secrets);
  context.subscriptions.push(...registerOllamaManagement(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('smart-commit-generator.generate', async (scmOrUri?: { rootUri?: vscode.Uri } | vscode.Uri) => {
      const uri = scmOrUri && 'rootUri' in scmOrUri ? scmOrUri.rootUri : (scmOrUri as vscode.Uri | undefined);
      await handleGenerateCommitMessage(gitService, uri, false);
    }),
    vscode.commands.registerCommand('smart-commit-generator.generateWithOptions', async (scmOrUri?: { rootUri?: vscode.Uri } | vscode.Uri) => {
      const uri = scmOrUri && 'rootUri' in scmOrUri ? scmOrUri.rootUri : (scmOrUri as vscode.Uri | undefined);
      await handleGenerateCommitMessage(gitService, uri, true);
    }),
    vscode.commands.registerCommand('smart-commit-generator.configure', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'smartCommit');
    })
  );
}

export async function handleGenerateCommitMessage(
  gitService: GitService,
  sourceControlUri?: vscode.Uri,
  interactive: boolean = false
) {
  const repo = await gitService.getRepository(sourceControlUri);
  if (!repo) {
    vscode.window.showWarningMessage('No Git repository found.');
    return;
  }

  const gitignoreWarnings = await gitService.getGitignoreWarnings(repo);
  if (gitignoreWarnings.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Git ignore check: ${gitignoreWarnings.join(' ')}`,
      'Continue', 'Cancel'
    );
    if (choice !== 'Continue') return;
  }

  const config = vscode.workspace.getConfiguration('smartCommit');
  const format = config.get<string>('format', 'conventional');
  const includeScope = config.get<boolean>('includeScope', true);
  const includeBody = config.get<boolean>('includeBody', false);
  const autoStageIfNone = config.get<boolean>('autoStageIfNone', false);
  const fallbackToUnstaged = config.get<boolean>('fallbackToUnstaged', true);
  const emojiStyle = config.get<'gitmoji' | 'simple'>('emojiStyle', 'gitmoji');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: 'Smart Commit: Generating commit message…'
    },
    async () => {
      const { fileDiffs } = await gitService.getDiff(repo, fallbackToUnstaged, autoStageIfNone);
      if (!fileDiffs || fileDiffs.length === 0) {
        vscode.window.showInformationMessage('No changes found in Git repository.');
        return;
      }

      const result = DiffAnalyzer.analyze(fileDiffs, { includeScope, includeBody, emojiStyle });
      let selectedFormat = format;
      let selectedMessage = result.conventional;

      if (interactive) {
        const chosen = await vscode.window.showQuickPick([
          { label: 'Conventional', description: result.conventional.split('\n')[0], format: 'conventional', fallback: result.conventional },
          { label: 'Emoji', description: result.emoji.split('\n')[0], format: 'emoji', fallback: result.emoji },
          { label: 'Simple', description: result.simple.split('\n')[0], format: 'simple', fallback: result.simple },
          { label: 'Detailed (with summary bullets)', description: result.detailed.split('\n')[0], format: 'detailed', fallback: result.detailed }
        ], { placeHolder: 'Select commit message style' });
        if (!chosen) return;
        selectedFormat = chosen.format;
        selectedMessage = chosen.fallback;
      } else {
        if (format === 'emoji') selectedMessage = result.emoji;
        else if (format === 'simple') selectedMessage = result.simple;
        else if (format === 'detailed') selectedMessage = result.detailed;
        else selectedMessage = result.conventional;
      }

      const aiMessage = await generateWithOllama(
        fileDiffs,
        {
          format: selectedFormat,
          includeScope,
          includeBody: selectedFormat === 'detailed' ? true : includeBody,
          emojiStyle
        },
        result.body,
        60000
      );
      if (aiMessage) selectedMessage = aiMessage;

      gitService.setCommitMessage(repo, selectedMessage);
      vscode.window.setStatusBarMessage(`Smart Commit: "${selectedMessage.split('\n')[0]}"`, 4000);
    }
  );
}

/** Generate a commit message using the user's Smart Commit settings. */
export async function generateCommitMessage(fileDiffs: Parameters<typeof DiffAnalyzer.analyze>[0]): Promise<string> {
  const config = vscode.workspace.getConfiguration('smartCommit');
  const format = config.get<string>('format', 'conventional');
  const includeScope = config.get<boolean>('includeScope', true);
  const includeBody = config.get<boolean>('includeBody', false);
  const emojiStyle = config.get<'gitmoji' | 'simple'>('emojiStyle', 'gitmoji');

  const result = DiffAnalyzer.analyze(fileDiffs, {
    includeScope,
    includeBody,
    emojiStyle
  });

  const aiMessage = await generateWithOllama(
    fileDiffs,
    {
      format,
      includeScope,
      includeBody: format === 'detailed' ? true : includeBody,
      emojiStyle
    },
    result.body,
    60000
  );
  if (aiMessage) return aiMessage;

  let fallback: string;
  switch (format) {
    case 'emoji': fallback = result.emoji; break;
    case 'simple': fallback = result.simple; break;
    case 'detailed': fallback = result.detailed; break;
    default: fallback = result.conventional; break;
  }
  // Ollama failures are reported in the Smart Commit AI Output channel; keep the fallback clean.
  return fallback;
}
