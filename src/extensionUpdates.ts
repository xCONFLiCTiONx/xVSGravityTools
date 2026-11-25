import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';

const LAST_VERSION_KEY = 'extensionUpdates.lastVscodeVersion';
const ORIGINAL_AUTO_UPDATE_KEY = 'extensionUpdates.originalAutoUpdate';
const ORIGINAL_CAPTURED_KEY = 'extensionUpdates.originalAutoUpdateCaptured';

type AutoUpdateValue = string | null;

async function enforceAutoUpdateOff(context: vscode.ExtensionContext): Promise<void> {
    const globalConfiguration = vscode.workspace.getConfiguration('extensions');
    const captured = context.globalState.get<boolean>(ORIGINAL_CAPTURED_KEY, false);

    if (!captured) {
        const original = globalConfiguration.inspect<string>('autoUpdate')?.globalValue;
        await context.globalState.update(ORIGINAL_AUTO_UPDATE_KEY, original ?? null);
        await context.globalState.update(ORIGINAL_CAPTURED_KEY, true);
    }

    if (globalConfiguration.get<string>('autoUpdate') !== 'off') {
        await globalConfiguration.update('autoUpdate', 'off', vscode.ConfigurationTarget.Global);
    }
}

async function restoreAutoUpdate(context: vscode.ExtensionContext): Promise<void> {
    if (!context.globalState.get<boolean>(ORIGINAL_CAPTURED_KEY, false)) {
        return;
    }

    const original = context.globalState.get<AutoUpdateValue>(ORIGINAL_AUTO_UPDATE_KEY, null);
    await vscode.workspace.getConfiguration('extensions').update(
        'autoUpdate',
        original ?? undefined,
        vscode.ConfigurationTarget.Global
    );

    await context.globalState.update(ORIGINAL_AUTO_UPDATE_KEY, undefined);
    await context.globalState.update(ORIGINAL_CAPTURED_KEY, false);
}

function updateInstalledExtensions(): Promise<void> {
    return new Promise((resolve, reject) => {
        // process.execPath points to the running Electron executable (Code.exe),
        // which does not expose the VS Code CLI arguments in this context.
        // Invoke the installed CLI shim from the VS Code installation instead.
        const cliPath = process.platform === 'win32'
            ? path.resolve(vscode.env.appRoot, '..', '..', 'bin', 'code.cmd')
            : path.resolve(vscode.env.appRoot, '..', '..', 'bin', 'code');

        const child = spawn(cliPath, ['--update-extensions'], {
            windowsHide: true,
            shell: process.platform === 'win32',
            stdio: ['ignore', 'ignore', 'pipe']
        });

        let errorOutput = '';
        child.stderr?.on('data', (chunk: Buffer | string) => {
            errorOutput += chunk.toString();
            if (errorOutput.length > 4000) {
                errorOutput = errorOutput.slice(-4000);
            }
        });

        child.once('error', reject);
        child.once('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(
                    errorOutput.trim() ||
                    `VS Code extension updater exited with code ${code ?? 'unknown'}.`
                ));
            }
        });
    });
}

export async function activateExtensionUpdates(context: vscode.ExtensionContext): Promise<void> {
    const applySettingAndCheckVersion = async (): Promise<void> => {
        const enabled = vscode.workspace
            .getConfiguration('xVSGravityTools.extensionUpdates')
            .get<boolean>('manage', true);

        if (!enabled) {
            try {
                await restoreAutoUpdate(context);
            } catch (error) {
                void vscode.window.showErrorMessage(
                    `xVSGravityTools could not restore extensions.autoUpdate: ${String(error)}`
                );
            }
            return;
        }

        try {
            await enforceAutoUpdateOff(context);
        } catch (error) {
            void vscode.window.showErrorMessage(
                `xVSGravityTools could not disable VS Code extension auto-updates: ${String(error)}`
            );
        }

        const currentVersion = vscode.version;
        const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);

        // Establish a baseline on first activation; do not update extensions just
        // because xVSGravityTools was installed or enabled for the first time.
        if (!lastVersion) {
            await context.globalState.update(LAST_VERSION_KEY, currentVersion);
            return;
        }

        if (lastVersion === currentVersion) {
            return;
        }

        // Only persist the new version after a successful update pass.
        // If the CLI fails, the next VS Code startup can retry.

        void vscode.window.showInformationMessage(
            `VS Code updated to ${currentVersion}. xVSGravityTools is updating installed extensions...`
        );

        try {
            await updateInstalledExtensions();
            await context.globalState.update(LAST_VERSION_KEY, currentVersion);
            void vscode.window.showInformationMessage(
                'xVSGravityTools finished checking for and installing extension updates.'
            );
        } catch (error) {
            void vscode.window.showErrorMessage(
                `xVSGravityTools could not update extensions: ${String(error)}`
            );
        }
    };

    await applySettingAndCheckVersion();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('xVSGravityTools.extensionUpdates.manage')) {
                void applySettingAndCheckVersion();
                return;
            }

            if (event.affectsConfiguration('extensions.autoUpdate') &&
                vscode.workspace.getConfiguration('xVSGravityTools.extensionUpdates').get<boolean>('manage', true)) {
                // Keep the global setting off while this manager is enabled.
                void enforceAutoUpdateOff(context).catch(error => {
                    void vscode.window.showErrorMessage(
                        `xVSGravityTools could not enforce extensions.autoUpdate = off: ${String(error)}`
                    );
                });
            }
        })
    );
}
