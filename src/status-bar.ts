import * as vscode from 'vscode';
import { CompilerConnectionStatus, connectionHandler } from './connection-handler';
import { getActiveToolchain } from './toolchain';

export enum HydraStatusBarStates {
	MissingToolchain,
	Disconnected,
	Connecting,
	Connected
}

export function activate(context: vscode.ExtensionContext) {
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
	statusBarItem.hide();

	const update = () => {
		const toolchain = getActiveToolchain();

		if (!toolchain) {
			statusBarItem.text = '$(alert) Hydra - Missing Toolchain';
			statusBarItem.tooltip = 'Open Extension Settings';
			statusBarItem.command = 'toadman-code-assist.openSettings';
			statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
			statusBarItem.show();
			return;
		}

		switch (connectionHandler.getCompilerConnectionStatus()) {
			case (CompilerConnectionStatus.Disconnected): {
				statusBarItem.text = '$(alert) Hydra - Disconnected';
				
				const config = vscode.workspace.getConfiguration('Hydra');
				const spawnOwnCompilerProcess: boolean | null | undefined = config.get('spawnOwnCompilerProcess');

				if (spawnOwnCompilerProcess) {
					statusBarItem.tooltip = 'Reconnect to Hydra or launch new compiler process';
				} else {
					statusBarItem.tooltip = 'Reconnect to Hydra. Make sure Hydra is running.';
				}
				statusBarItem.command = 'toadman-code-assist.Compiler.reconnect';
				statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
				statusBarItem.show();
				break;
			}
			case (CompilerConnectionStatus.Connecting): {

				const config = vscode.workspace.getConfiguration('Hydra');
				const spawnOwnCompilerProcess: boolean | null | undefined = config.get('spawnOwnCompilerProcess');

				if (spawnOwnCompilerProcess) {
					statusBarItem.text = '$(loading~spin) Hydra - Connecting';
					statusBarItem.tooltip = 'Connecting to Hydra...';
				} else {
					statusBarItem.text = '$(loading~spin) Hydra - Please open Hydra...';
					statusBarItem.tooltip = 'Waiting for Hydra to open';
				}
				statusBarItem.command = 'toadman-code-assist.Compiler.reconnect';
				statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				statusBarItem.show();
				break;
			}
			case (CompilerConnectionStatus.Connected): {
				statusBarItem.text = 'Hydra - Connected';
				statusBarItem.tooltip = 'Open Compiler Log';
				statusBarItem.command = 'toadman-code-assist.Compiler.openLog';
				statusBarItem.backgroundColor = new vscode.ThemeColor("statusBar.background");
				statusBarItem.show();
				break;
			}
		}
	};

	vscode.workspace.onDidChangeWorkspaceFolders(update);
	vscode.workspace.onDidChangeConfiguration(update);
	connectionHandler.onCompilerConnectionStatusChanged.add(update);
	update();
}