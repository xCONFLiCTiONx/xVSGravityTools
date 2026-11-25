import * as vscode from 'vscode';

const API_KEY_SECRET = 'smartCommit.ollamaApiKey';

function serverUrl(): string {
  const config = vscode.workspace.getConfiguration('smartCommit');
  return (config.get<string>('ollamaUrl', '') || '').trim().replace(/\/+$/, '');
}

async function authHeaders(context: vscode.ExtensionContext): Promise<Record<string, string>> {
  const key = await context.secrets.get(API_KEY_SECRET);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function readError(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 500);
}

export function registerOllamaManagement(context: vscode.ExtensionContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('smart-commit-generator.setOllamaApiKey', async () => {
      const value = await vscode.window.showInputBox({
        title: 'Set Ollama API Key',
        prompt: 'Stored securely in VS Code SecretStorage. Leave blank to clear it.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'API key (optional)'
      });
      if (value === undefined) return;
      if (!value.trim()) {
        await context.secrets.delete(API_KEY_SECRET);
        vscode.window.showInformationMessage('Ollama API key cleared.');
      } else {
        await context.secrets.store(API_KEY_SECRET, value.trim());
        vscode.window.showInformationMessage('Ollama API key saved securely.');
      }
    }),

    vscode.commands.registerCommand('smart-commit-generator.clearOllamaApiKey', async () => {
      await context.secrets.delete(API_KEY_SECRET);
      vscode.window.showInformationMessage('Ollama API key cleared.');
    }),

    vscode.commands.registerCommand('smart-commit-generator.selectOllamaModel', async () => {
      const url = serverUrl();
      if (!url) { vscode.window.showWarningMessage('Set the Inference API URL in Commit Settings first.'); return; }
      const apiBase = url.endsWith('/v1') ? url : url + '/v1';
      try {
        const response = await fetch(apiBase + '/models', { headers: await authHeaders(context) });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await readError(response)}`);
        const data = await response.json() as { data?: Array<{ id?: string }> };
        const models = [...new Set((data.data || []).map(model => model.id?.trim()).filter((id): id is string => !!id))].sort();
        if (!models.length) throw new Error('The inference endpoint returned no selectable models.');
        const currentModel = (vscode.workspace.getConfiguration('smartCommit').get<string>('ollamaModel', '') || '').trim();
        const selected = await vscode.window.showQuickPick(models.map(id => ({ label: id, description: id === currentModel ? 'Current model' : undefined })), {
          title: 'Select AI Model',
          placeHolder: 'Choose any model exposed by your inference endpoint',
          matchOnDescription: true
        });
        if (!selected) return;
        await vscode.workspace.getConfiguration('smartCommit').update('ollamaModel', selected.label, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Smart Commit is using ${selected.label}.`);
      } catch (error) {
        vscode.window.showErrorMessage(`Could not load models: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  ];
}
