import { ChildProcess, exec } from 'child_process';
import { join as pathJoin, normalize } from 'path';
import * as vscode from 'vscode';
import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { connectionHandler, MAX_CONNECTIONS } from './connection-handler';
import { StingrayConnection } from './stingray-connection';
import * as languageFeatures from './stingray-language-features';
import * as taskProvider from './stingray-task-provider';
import type { Target } from './utils/stingray-config';
import { StingrayToolchain } from "./utils/stingray-toolchain";
import { ConnectionsNodeProvider } from './views/connections-node-provider';
import { TargetsNodeProvider } from './views/targets-node-provider';
import { createHmac } from 'crypto';

let _activeToolchain: StingrayToolchain;
let _compilerProcess: ChildProcess | null;
let _compilerPromiseRunning = false;
let closed = false;

export const getToolchainPath = (): string|null|undefined => {

	const config = vscode.workspace.getConfiguration('Hydra');
	const binariesPath: string|null|undefined = config.get('binariesPath');
	return binariesPath;
};

export const getActiveToolchain = () => {
	if (_activeToolchain) {
		return _activeToolchain;
	}
	
	const toolchainPath = getToolchainPath();
	if (!toolchainPath) {
		return null;
	}

	try {
		_activeToolchain = new StingrayToolchain(toolchainPath);
	} catch (err) {
		return null;
	}
	
	return _activeToolchain;
};

const generateAssetServerSecretKey = async (): Promise<string> => {
	const appDataFolder: string | undefined = process.env.LOCALAPPDATA;

	if (appDataFolder === undefined) {
		throw new Error('This extension only works on Windows.');
	}

	const toadmanAppDataFolder = pathJoin(appDataFolder, "Toadman");

	try {
		await access(toadmanAppDataFolder);
	} catch {
		await mkdir(toadmanAppDataFolder);
	}

	const hydraAppDataFolder = pathJoin(toadmanAppDataFolder, "Hydra");

	try {
		await access(hydraAppDataFolder);
	} catch {
		await mkdir(hydraAppDataFolder);
	}

	const sskFile = pathJoin(hydraAppDataFolder, ".ssk");

	const ssk = createHmac('sha256', 'a secret').digest('base64');
	await writeFile(sskFile, ssk);

	return ssk;
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


const compilerConnector = async function (): Promise<StingrayConnection> {
	return await new Promise ((resolve) => {
		const compiler = connectionHandler.getCompiler();

		if (compiler.isReady) {
			resolve(compiler);
			return;
		}

		let resolver = () => {
			compiler.onDidConnect.remove(resolver);
			compiler.onDidDisconnect.remove(resolver);

			resolve(compiler);
		};
		compiler.onDidConnect.add(resolver);
		compiler.onDidDisconnect.add(resolver);
	});
};

const killChildProcess = async function(process: ChildProcess) {
	await new Promise<boolean>((resolve) => {
		exec(`taskkill /pid ${process.pid} /T /F`, (error) => {
			const code = error?.code || 0;
			resolve(code === 0);
		});
	});
};

export const activate = (context: vscode.ExtensionContext) => {
	languageFeatures.activate(context);
	taskProvider.activate(context);

	vscode.workspace.onDidChangeWorkspaceFolders(updateIsStingrayProject);
	vscode.workspace.onDidChangeConfiguration(updateIsStingrayProject);
	updateIsStingrayProject();
	
	const extensionOutputChannel = vscode.window.createOutputChannel("toadman-code-assist");

	const loopUntilConnectionDrops = async (connection: StingrayConnection) => {
		while (!closed) {
			if (connection.isClosed) {
				extensionOutputChannel.appendLine(`Lost connection to compile server. Retry with command [command:toadman-code-assist.Compiler.reconnect].`);
				extensionOutputChannel.show(false);
				vscode.window.showInformationMessage(`Lost connection to compiler. See extension log.`);

				return;
			}
			
			await new Promise(f => setTimeout(f, 1000));
		}
	};

	const keepCompilerRunning = function () {
		async function subroutine() {

			/// KILL EXISTING PROCESS IF THERE IS ONE

			if (_compilerProcess) {
				await killChildProcess(_compilerProcess);
				_compilerProcess = null;
			}

			/// CHECK TOOLCHAIN

			const toolchain = getActiveToolchain();

			if (!toolchain) {
				const toolchainPath = getToolchainPath();

				if (!toolchainPath) {
					extensionOutputChannel.appendLine(`The toolchain path is not complete. Go to the extension settings and make sure your path is correctly set.`);
				} else {
					extensionOutputChannel.appendLine(`No toolchain found in path "${toolchainPath}". Set a correct path in the settings.`);
				}
				extensionOutputChannel.appendLine(`After properly configuring the toolchain, run the command [command:toadman-code-assist.Compiler.reconnect].`);
				extensionOutputChannel.show(false);
				vscode.window.showInformationMessage(`Toolchain not properly configured. See extension log.`);

				return;
			}

			/// CHECK IF ANOTHER COMPILER IS RUNNING AND ATTACH TO IT. E.G. HYDRA EDITOR

			const existingCompilerConnection = await compilerConnector();

			if (existingCompilerConnection.isReady) {
				vscode.window.showInformationMessage(`Compiler connection established.`);
				extensionOutputChannel.appendLine(`Compiler connected!`);

				return await loopUntilConnectionDrops(existingCompilerConnection);
			}

			const secret = await generateAssetServerSecretKey();

			const commandAndChildProcess = await toolchain.launch({
				targetId: '00000000-1111-2222-3333-444444444444',
				arguments: ['--asset-server', '--secret', secret],
			});

			const command = commandAndChildProcess.command;
			extensionOutputChannel.appendLine(`Launching compiler with command ${command}`);
			_compilerProcess = commandAndChildProcess.childProcess;

			let childProcessConnection;
			for (let i = 0; i < 20; ++i) {
				childProcessConnection = await compilerConnector();
				if (childProcessConnection.isReady) {
					break;
				}
				
				if (_compilerProcess.exitCode) {
					if (_compilerProcess.exitCode !== 0) {
						extensionOutputChannel.appendLine(`The compiler failed to launch with exit code ${_compilerProcess.exitCode}.`);
						_compilerProcess = null;
						break;
					}
				} else {
					extensionOutputChannel.appendLine(`Compiler still starting...`);
				}

				await new Promise(f => setTimeout(f, 1000));
			}

			if (!childProcessConnection || !childProcessConnection.isReady) {
				if (_compilerProcess) {
					await killChildProcess(_compilerProcess);
					_compilerProcess = null;
				}

				extensionOutputChannel.appendLine(`Failed to launch compile server. Check the launch command for it in the log before and see if it's correct. After fixing settings run the command [command:toadman-code-assist.Compiler.reconnect].`);
				extensionOutputChannel.show(false);
				vscode.window.showInformationMessage(`Failed to launch compile server. See extension log.`);
				return;
			}

			vscode.window.showInformationMessage(`Compiler connection established.`);
			extensionOutputChannel.appendLine(`Compiler connected!`);

			return await loopUntilConnectionDrops(childProcessConnection);
		}

		_compilerPromiseRunning = true;
		subroutine().finally(() => {
			_compilerPromiseRunning = false;

			if (_compilerProcess) {
				killChildProcess(_compilerProcess);
				_compilerProcess = null;
			}
		});
	};

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

	context.subscriptions.push(vscode.commands.registerCommand("toadman-code-assist.Compiler.reconnect", () => {
		if (_compilerPromiseRunning) {
			vscode.window.showInformationMessage(`Already connected or connecting to compiler.`);
			return;
		}
		keepCompilerRunning();
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

	keepCompilerRunning();

	connectionHandler.onConnectionsChanged.add(() => {
		connectionsNodeProvider.refresh();
	});
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
		killChildProcess(_compilerProcess);
	}
};
