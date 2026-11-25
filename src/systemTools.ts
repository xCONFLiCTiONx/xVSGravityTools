import * as vscode from 'vscode';
import * as os from 'os';
import * as net from 'net';
import * as https from 'https';
import { exec } from 'child_process';

let networkOutputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!networkOutputChannel) {
        networkOutputChannel = vscode.window.createOutputChannel('xVSGravityTools: Network Info');
    }
    return networkOutputChannel;
}

export function activateSystemTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('systemTools.checkInternet', async () => {
            await checkInternetConnectivity();
        }),
        vscode.commands.registerCommand('systemTools.flushDns', async () => {
            await flushDnsCache();
        }),
        vscode.commands.registerCommand('systemTools.networkInfo', async () => {
            await showNetworkInfo();
        })
    );
}

/**
 * Tests internet connectivity by attempting a socket connection to primary DNS servers
 * and an HTTPS latency test.
 */
async function checkInternetConnectivity(): Promise<void> {
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'xVSGravityTools: Checking Internet Connectivity...',
            cancellable: false
        },
        async () => {
            const start = Date.now();
            const dnsHosts = [
                { host: '1.1.1.1', port: 53 },
                { host: '8.8.8.8', port: 53 }
            ];

            let connected = false;
            let latency = 0;

            for (const target of dnsHosts) {
                try {
                    await pingTcp(target.host, target.port, 2500);
                    latency = Date.now() - start;
                    connected = true;
                    break;
                } catch {
                    // Try next host
                }
            }

            if (!connected) {
                // Secondary fallback via HTTPS request
                try {
                    const httpStart = Date.now();
                    await fetchHttpProbe('https://www.google.com/generate_204', 3000);
                    latency = Date.now() - httpStart;
                    connected = true;
                } catch {
                    connected = false;
                }
            }

            if (connected) {
                const action = await vscode.window.showInformationMessage(
                    `🌐 Internet Connected: Online (Ping: ${latency}ms)`,
                    'Network Info',
                    'Flush DNS'
                );
                if (action === 'Network Info') {
                    await showNetworkInfo();
                } else if (action === 'Flush DNS') {
                    await flushDnsCache();
                }
            } else {
                const action = await vscode.window.showErrorMessage(
                    '❌ No Internet Connection detected. You appear to be offline.',
                    'Check Network Info',
                    'Flush DNS'
                );
                if (action === 'Check Network Info') {
                    await showNetworkInfo();
                } else if (action === 'Flush DNS') {
                    await flushDnsCache();
                }
            }
        }
    );
}

function pingTcp(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let isSettled = false;

        socket.setTimeout(timeoutMs);

        socket.on('connect', () => {
            if (!isSettled) {
                isSettled = true;
                socket.destroy();
                resolve();
            }
        });

        socket.on('timeout', () => {
            if (!isSettled) {
                isSettled = true;
                socket.destroy();
                reject(new Error(`Timeout connecting to ${host}:${port}`));
            }
        });

        socket.on('error', (err) => {
            if (!isSettled) {
                isSettled = true;
                socket.destroy();
                reject(err);
            }
        });

        socket.connect(port, host);
    });
}

function fetchHttpProbe(urlStr: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = https.get(urlStr, { timeout: timeoutMs }, (res) => {
            res.resume(); // consume response data to free up memory
            resolve();
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('HTTP probe timed out'));
        });
        req.on('error', reject);
    });
}

/**
 * Platform-aware DNS resolver cache flush.
 */
async function flushDnsCache(): Promise<void> {
    const platform = process.platform;
    let cmd = '';

    if (platform === 'win32') {
        cmd = 'ipconfig /flushdns';
    } else if (platform === 'darwin') {
        cmd = 'dscacheutil -flushcache; killall -HUP mDNSResponder';
    } else {
        // Linux systemd / resolvectl
        cmd = 'resolvectl flush-caches || systemd-resolve --flush-caches || /etc/init.d/nscd restart';
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'xVSGravityTools: Flushing DNS Cache...',
            cancellable: false
        },
        () => {
            return new Promise<void>((resolve) => {
                exec(cmd, (error, stdout, stderr) => {
                    if (error) {
                        const errMsg = (stderr || stdout || error.message).trim();
                        vscode.window.showErrorMessage(`Failed to flush DNS cache: ${errMsg}`);
                    } else {
                        const outMsg = (stdout || '').trim();
                        const channel = getOutputChannel();
                        channel.appendLine(`[${new Date().toLocaleTimeString()}] DNS Cache Flushed:`);
                        channel.appendLine(outMsg || 'DNS Cache cleared successfully.');
                        vscode.window.showInformationMessage('✅ Successfully flushed system DNS Resolver Cache.', 'View Details').then(choice => {
                            if (choice === 'View Details') {
                                channel.show();
                            }
                        });
                    }
                    resolve();
                });
            });
        }
    );
}

/**
 * Gathers system network interfaces, host details, and queries public IP.
 */
async function showNetworkInfo(): Promise<void> {
    const channel = getOutputChannel();
    channel.clear();
    channel.appendLine(`=========================================`);
    channel.appendLine(` xVSGravityTools Network Information Report`);
    channel.appendLine(` Generated: ${new Date().toLocaleString()}`);
    channel.appendLine(` Hostname:  ${os.hostname()}`);
    channel.appendLine(` Platform:  ${os.platform()} (${os.arch()})`);
    channel.appendLine(`=========================================\n`);

    const interfaces = os.networkInterfaces();
    interface PickItem extends vscode.QuickPickItem {
        copyValue?: string;
        action?: 'details' | 'systemCmd';
    }

    const items: PickItem[] = [];
    let primaryIpv4: string | undefined;

    channel.appendLine(`--- Local Network Interfaces ---`);
    for (const [name, netList] of Object.entries(interfaces)) {
        if (!netList) continue;
        channel.appendLine(`Interface: ${name}`);
        for (const netInfo of netList) {
            channel.appendLine(`  - Family:   ${netInfo.family}`);
            channel.appendLine(`    Address:  ${netInfo.address}`);
            channel.appendLine(`    Netmask:  ${netInfo.netmask}`);
            channel.appendLine(`    MAC:      ${netInfo.mac}`);
            channel.appendLine(`    Internal: ${netInfo.internal}`);

            if (netInfo.family === 'IPv4' && !netInfo.internal && !primaryIpv4) {
                primaryIpv4 = netInfo.address;
            }

            if (!netInfo.internal && (netInfo.family === 'IPv4' || netInfo.family === 'IPv6')) {
                items.push({
                    label: `$(radio-tower) ${name} (${netInfo.family}): ${netInfo.address}`,
                    description: `MAC: ${netInfo.mac}`,
                    detail: 'Click to copy IP address to clipboard',
                    copyValue: netInfo.address
                });
            }
        }
        channel.appendLine('');
    }

    // Try fetching public IP
    let publicIp: string | undefined;
    try {
        publicIp = await fetchPublicIp(3000);
        channel.appendLine(`Public / External IP: ${publicIp}\n`);
    } catch {
        channel.appendLine(`Public / External IP: Unable to resolve (Offline or blocked)\n`);
    }

    if (publicIp) {
        items.unshift({
            label: `$(globe) Public IP: ${publicIp}`,
            description: 'External Internet Address',
            detail: 'Click to copy Public IP to clipboard',
            copyValue: publicIp
        });
    }

    items.push({
        label: `$(output) View Full Network Report in Output Channel`,
        description: 'Detailed interfaces & routing dump',
        action: 'details'
    });

    items.push({
        label: `$(terminal) Run System Command (${process.platform === 'win32' ? 'ipconfig /all' : 'ifconfig -a'})`,
        description: 'Execute native system diagnostics in output channel',
        action: 'systemCmd'
    });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Network Summary (Hostname: ${os.hostname()} | Primary IP: ${primaryIpv4 || 'None'})`,
        matchOnDescription: true,
        matchOnDetail: true
    });

    if (!selected) return;

    if (selected.copyValue) {
        await vscode.env.clipboard.writeText(selected.copyValue);
        vscode.window.showInformationMessage(`Copied "${selected.copyValue}" to clipboard.`);
    } else if (selected.action === 'details') {
        channel.show();
    } else if (selected.action === 'systemCmd') {
        const cmd = process.platform === 'win32' ? 'ipconfig /all' : 'ifconfig -a';
        channel.show();
        channel.appendLine(`\n>>> Executing: ${cmd}...\n`);
        exec(cmd, (err, stdout, stderr) => {
            if (err) {
                channel.appendLine(`Error: ${stderr || err.message}`);
            } else {
                channel.appendLine(stdout);
            }
        });
    }
}

function fetchPublicIp(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = https.get('https://api.ipify.org?format=json', { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.ip) {
                        resolve(parsed.ip);
                    } else {
                        reject(new Error('Invalid response'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Public IP request timed out'));
        });
        req.on('error', reject);
    });
}

