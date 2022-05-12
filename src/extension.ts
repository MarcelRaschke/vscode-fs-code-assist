import { ChildProcess, exec } from 'child_process';
import { join as pathJoin } from 'path';
import * as vscode from 'vscode';
import { connectionHandler, MAX_CONNECTIONS } from './connection-handler';
import { StingrayConnection } from './stingray-connection';
import * as languageFeatures from './stingray-language-features';
import * as taskProvider from './stingray-task-provider';
import type { Target } from './utils/stingray-config';
import { StingrayToolchain } from "./utils/stingray-toolchain";
import { ConnectionsNodeProvider } from './views/connections-node-provider';
import { TargetsNodeProvider } from './views/targets-node-provider';

let _activeToolchain: StingrayToolchain;
let _compilerProcess: ChildProcess | null;
let closed = false;
export const getActiveToolchain = () => {
	if (_activeToolchain) {
		return _activeToolchain;
	}
	const config = vscode.workspace.getConfiguration('Hydra');
	const toolchainRoot: string = config.get('toolchainPath') || process.env.BsBinariesDir || 'C:/BitSquidBinaries';
	const toolchainName: string = config.get('toolchainName') || 'vermintide2';
	if (!toolchainRoot || !toolchainName) {
		return null;
	}
	_activeToolchain = new StingrayToolchain(pathJoin(toolchainRoot, toolchainName));
	return _activeToolchain;
};

const updateIsStingrayProject = async () => {
	let bool = false;
	const workspaceRootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
	if (workspaceRootPath) {
		const toolchain = getActiveToolchain();
		if (toolchain) {
			const config = await toolchain.config();
			bool = config.Projects.some((project) => {
				return project.SourceDirectory.toUpperCase() === workspaceRootPath.toUpperCase();
			});
		}
	}
	vscode.commands.executeCommand('setContext', 'toadman-code-assist:isStingrayProject', bool);
};

export const activate = (context: vscode.ExtensionContext) => {
	languageFeatures.activate(context);
	taskProvider.activate(context);

	vscode.workspace.onDidChangeWorkspaceFolders(updateIsStingrayProject);
	vscode.workspace.onDidChangeConfiguration(updateIsStingrayProject);
	updateIsStingrayProject();

	const targetsNodeProvider = new TargetsNodeProvider();
	context.subscriptions.push(vscode.window.createTreeView("toadman-code-assist-Targets", {
		treeDataProvider: targetsNodeProvider,
		showCollapseAll: false,
		canSelectMany: true,
	}));

	// Connected clients panel
	const connectionsNodeProvider = new ConnectionsNodeProvider();
	context.subscriptions.push(vscode.window.createTreeView("toadman-code-assist-Connections", {
		treeDataProvider: connectionsNodeProvider,
		showCollapseAll: false,
		canSelectMany: true,
	}));

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist.Target.scan", (target?: Target) => {
		connectionHandler.getCompiler();

		const isWin32 = target ? target.Platform === "win32" : true;
		const port = isWin32 ? 14000 : target!.Port;
		const maxConnections = isWin32 ? MAX_CONNECTIONS : 1;
		connectionHandler.connectAllGames(port, maxConnections, target?.Ip);
	}));

	const connectionsForCommand = (connection: StingrayConnection, allSelected?: StingrayConnection[]): StingrayConnection[] => {
		if (allSelected) {
			return allSelected;
		} else if (connection instanceof StingrayConnection) {
			return [ connection ];
		} else {
			return connectionHandler.getAllGames();
		}
	};

	context.subscriptions.push(vscode.commands.registerCommand('toadman-code-assist.Connection.attachDebugger', (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		connectionsForCommand(connection, allSelected).forEach((game) => {
			const { ip, port } = game;

			const toolchain = getActiveToolchain();
			if (!toolchain) {
				return;
			}

			const attachArgs = {
				"type": "hydra",
				"request": "attach",
				"name": `${game.ip}:${game.port}`,
				"ip" : ip,
				"toolchain": toolchain.path,
				"port" : port,
				"args": ["--colors"],
				"console": "integratedTerminal",
				"debugServer": process.env.TOADMAN_CODE_ASSIST_DEBUG_MODE ? 4711 : undefined,
			};
			vscode.debug.startDebugging(undefined, attachArgs);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('toadman-code-assist.Connection.disconnect', (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		connectionsForCommand(connection, allSelected).forEach((game) => {
			game.close();
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist.Connection.executeCommand", async (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		const value = await vscode.window.showInputBox({prompt: "Command"}) || "";
		const args = value.split(/\s+/);
		const cmd = args.shift();
		if (cmd) {
			connectionsForCommand(connection, allSelected).forEach((game) => {
				game.sendCommand(cmd, ...args);
			});
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist.Connection.executeLua", async (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		const lua = await vscode.window.showInputBox({prompt: "Lua script"}) || "";
		connectionsForCommand(connection, allSelected).forEach((game) => {
			game.sendLua(lua);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist.Connection.executeSelection", (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			const selectionText = textEditor.document.getText(textEditor.selection);
			if (selectionText.length > 0) {
				connectionsForCommand(connection, allSelected).forEach((game) => {
					game.sendLua(selectionText);
				});
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist.Connection.executeFile", (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			const script = textEditor.document.getText();
			connectionsForCommand(connection, allSelected).forEach((game) => {
				game.sendLua(script);
			});
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist.Connection.reloadResources", (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		connectionsForCommand(connection, allSelected).forEach((game) => {
			game.sendCommand("refresh");
			game.sendCommand("game", "unpause");
		});
		vscode.window.setStatusBarMessage("$(refresh) Sources hot reloaded.", 3000);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist.Connection._focusOutput", (connection: StingrayConnection) => {
		const outputChannel = connectionHandler.getOutputForConnection(connection);
		if (outputChannel) {
			outputChannel.show();
		} else {
			vscode.window.showWarningMessage(`No output channel for connection at ${connection?.ip}:${connection?.port}`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist.flushToolcenterConfig", () => {
		targetsNodeProvider.refresh();
	}));

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist._refreshConnectedClients", () => {
		connectionsNodeProvider.refresh();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('toadman-code-assist._goToResource', async (loc) => {
		if (!vscode.window.activeTextEditor) {
			return;
		}
		const toolchain = getActiveToolchain();
		if (!toolchain) {
			return;
		}
		const { file, line, external } = loc;
		const uri = vscode.Uri.file(file);
		if (external) {
			vscode.env.openExternal(uri);
		} else {
			if (line) {
				const document = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(document);
				const selection = new vscode.Selection(line-1, 0, line-1, 0);
				vscode.window.activeTextEditor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
				vscode.window.activeTextEditor.selection = selection;
			} else {
				vscode.commands.executeCommand('vscode.open', uri);
			}
		}
	}));

	const keepCompilerRunning = async function () {
		let connected = false;
		let toolchain_not_found = false;

		while (!closed) {
			await new Promise(f => setTimeout(f, 1000));
			
			const toolchain = getActiveToolchain();

			if (!toolchain) {
				if (!toolchain_not_found) {
					vscode.window.showInformationMessage(`No toolchain found.`);
					toolchain_not_found = true;
				}
				continue;
			}

			toolchain_not_found = false;

			const compiler = await new Promise<StingrayConnection>((resolve) => {

				const compiler = connectionHandler.getCompiler();

				if (compiler.isReady) {
					resolve(compiler);
					return;
				}
				
				vscode.window.showInformationMessage(`Connecting to compiler...`);

				let resolver = () => {
					compiler.onDidConnect.remove(resolver);
					compiler.onDidDisconnect.remove(resolver);

					resolve(compiler);
				};
				compiler.onDidConnect.add(resolver);
				compiler.onDidDisconnect.add(resolver);
			});

			if (compiler.isReady) {
				if (!connected) {
					connected = true;
					vscode.window.showInformationMessage(`Compiler connection established.`);
				}
	
				connected = true;
				continue;
			}

			if (compiler.isClosed) {
				connected = false;
				
				vscode.window.showInformationMessage(`Compiler not found, launching process...`);
				if (_compilerProcess) {
					const child = _compilerProcess;
					_compilerProcess = null;
					await new Promise<boolean>((resolve) => {
						exec(`taskkill /pid ${child.pid} /T /F`, (error) => {
							const code = error?.code || 0;
							resolve(code === 0);
						});
					});
				}
				
				_compilerProcess = await toolchain.launch({
					targetId: '00000000-1111-2222-3333-444444444444',
					arguments: `--asset-server`,
				});
			}
		}
	};
	 
	keepCompilerRunning();

	const keepConnecting = async function () {
		while (!closed) {
				
			const toolchain = getActiveToolchain()!;

			if (toolchain) {
				const config = await toolchain.config();

				for (const target of config.Targets) {
					const isWin32 = target ? target.Platform === "win32" : true;
					const port = isWin32 ? 14000 : target!.Port;
					const maxConnections = isWin32 ? MAX_CONNECTIONS : 1;
					connectionHandler.connectAllGames(port, maxConnections, target?.Ip);
				} 
			}

			await new Promise(f => setTimeout(f, 1000));
		}
	};

	keepConnecting();
};

export const deactivate = () => {
	closed = true;
	connectionHandler.closeAll();
	if (_compilerProcess) {
		exec(`taskkill /pid ${_compilerProcess.pid} /T /F`);
	}
};
