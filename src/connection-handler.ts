// Handles connections to stingray compile server and game clients.
// Handles creating and hooking to VS Code Output windows.
// Handles "Connected Clients" side panel refreshing.

import * as vscode from 'vscode';
import { StingrayConnection } from "./stingray-connection";
import { getTimestamp } from './utils/functions';
import Multicast from './utils/multicast';

export const MAX_CONNECTIONS = 31;

const IDENTIFY_TIMEOUT = 5000; // Milliseconds.
const IDENTIFY_LUA = `
--[[ print("[VSCode] Identifying instance...") ]]
local function GET(obj, method, default)
	return (function(ok, ...)
		if ok then return ... end
		return default
	end)(pcall(obj and obj[method]))
end
stingray.Application.console_send({
	type = "stingray_identify",
	info = {
		--[[ sysinfo = Application.sysinfo(), Too long! ]]
		argv = { GET(Application, "argv", "#ERROR!") },
		build = GET(Application, "build", BUILD),
		build_identifier = GET(Application, "build_identifier", BUILD_IDENTIFIER),
		bundled = GET(Application, "bundled"),
		console_port = GET(Application, "console_port"),
		process_id = GET(Application, "process_id"),
		session_id = GET(Application, "session_id"),
		platform = GET(Application, "platform"),
		time_since_launch = GET(Application, "time_since_launch"),
		jit = { GET(jit, "status") } ,
	},
})
`;

export enum CompilerConnectionStatus {
	Disconnected,
	Connecting,
	Connected,
}

export class ConnectionHandler {
	static readonly COMPILER_OUTPUT_NAME = "Stingray Compiler";
	readonly onConnectionsChanged = new Multicast();
	readonly onCompilerConnectionStatusChanged = new Multicast();
	private _compiler: StingrayConnection;
	private _compilerConnectionStatus: CompilerConnectionStatus;
	private _game = new Map<number, StingrayConnection>();
	private _connectionOutputs = new Map<StingrayConnection, vscode.OutputChannel>();
	private _outputsForConnection = new Map<vscode.OutputChannel, StingrayConnection>();
	private _identifyInfo = new Map<StingrayConnection, any>();
	private _outputsByName = new Map<string, vscode.OutputChannel>();

	constructor() {
		const compiler = new StingrayConnection(14032);
		this._compiler = compiler;

		//can't call the private method here because typescript doesn't see the initialization of the non-nullable
		this._compilerConnectionStatus = CompilerConnectionStatus.Connecting;
		this.onCompilerConnectionStatusChanged.fire(CompilerConnectionStatus.Connecting);

		const onDisconnect = () => {
			compiler.onDidConnect.remove(onConnect);
			compiler.onDidDisconnect.remove(onDisconnect);
			this._updateCompilerConnectionStatus(CompilerConnectionStatus.Disconnected);
		};
		const onConnect = () => {
			compiler.onDidConnect.remove(onConnect);
			compiler.onDidDisconnect.remove(onDisconnect);
			this._updateCompilerConnectionStatus(CompilerConnectionStatus.Connected);
		};
		this._compiler.onDidConnect.add(onConnect);
		this._compiler.onDidDisconnect.add(onDisconnect);
	}

	closeAll() {
		this._compiler?.close();
		for (const [_port, game] of this._game) {
			game.close();
		}
	}

	async connectToCompiler(attempts: number = 1, delay_between_attempts: number = 1000): Promise<StingrayConnection> {

		for (let i = 0; i < attempts; ++i) {
			this._updateCompilerConnectionStatus(CompilerConnectionStatus.Connecting);

			await new Promise(f => {
				if (!this._compiler.isClosed && this._compiler.isReady) {
					// was already connected
					f(this._compiler);
					return;
				}

				// check if a connection was already happening, i.e. isClosed == false and isReady == false
				const newCompiler = this._compiler.isClosed ? new StingrayConnection(14032) : this._compiler;
				this._compiler = newCompiler;

				const onDisconnect = () => {
					newCompiler.onDidConnect.remove(onConnect);
					newCompiler.onDidDisconnect.remove(onDisconnect);
					f(newCompiler);
				};
				const onConnect = () => {
					newCompiler.onDidConnect.remove(onConnect);
					newCompiler.onDidDisconnect.remove(onDisconnect);
					f(newCompiler);
				};
				
				newCompiler.onDidConnect.add(onConnect);
				newCompiler.onDidDisconnect.add(onDisconnect);
			});

			if (!this._compiler.isClosed && this._compiler.isReady) {
				break;
			}

			if (i + 1 !== attempts) {
				await new Promise(f => setTimeout(f, delay_between_attempts));
			}
		}

		if (!this._compiler.isClosed && this._compiler.isReady) {
			this._addOutputChannel(ConnectionHandler.COMPILER_OUTPUT_NAME, this._compiler, true);
			this._updateCompilerConnectionStatus(CompilerConnectionStatus.Connected);
			
			this._compiler.onDidDisconnect.add(() => {
				this._updateCompilerConnectionStatus(CompilerConnectionStatus.Disconnected);
			});
		} else {
			this._updateCompilerConnectionStatus(CompilerConnectionStatus.Disconnected);
		}
		return this._compiler;
	}

	getCompiler() {
		return this._compiler;
	}

	getCompilerConnectionStatus() {
		return this._compilerConnectionStatus;
	}

	getGame(port:number, ip?:string) {
		let game = this._game.get(port);
		if (!game || game.isClosed) {
			const newGame = new StingrayConnection(port, ip);

			let connected = false;
			newGame.onDidConnect.add(() => {
				this._addOutputChannel(`Stingray (${port})`, newGame, true);
				newGame.sendJSON({
					type: 'lua_debugger',
					command: 'continue',
				});
				this.onConnectionsChanged.fire();
				connected = true;
			});

			newGame.onDidDisconnect.add(() => {
				if (connected) {
					this.onConnectionsChanged.fire();
				}
			});
			
			this._game.set(port, newGame);
			game = newGame;
		}
		return game;
	}

	connectAllGames(portStart:number, range:number, ip?:string) {
		range = Math.min(range, MAX_CONNECTIONS);
		for (let i = 0; i < range; ++i) {
			this.getGame(portStart+i, ip);
		}
	}

	getAllGames() {
		const allGameConnections = [];
		for (const [_, game] of this._game) {
			if (game.isReady) {
				allGameConnections.push(game);
			}
		}
		return allGameConnections;
	}

	getOutputForConnection(connection:StingrayConnection) {
		return this._connectionOutputs.get(connection);
	}

	getOutputForName(outputName:string) {
		return this._outputsByName.get(outputName);
	}

	_updateCompilerConnectionStatus(newStatus: CompilerConnectionStatus) {
		this._compilerConnectionStatus = newStatus;
		this.onCompilerConnectionStatusChanged.fire(newStatus);
	}

	_addOutputChannel(name:string, connection:StingrayConnection, show: boolean = true) {
		// connection has to already be connected
		let outputChannel: vscode.OutputChannel;
		
		let oldOutputChannel = this._outputsByName.get(name);
		let oldConnection = oldOutputChannel ? this._outputsForConnection.get(oldOutputChannel) : null;
		
		if (oldConnection === connection ) {
			// output channel already created
			return;
		}

		if (oldOutputChannel) {
			oldOutputChannel.appendLine(``);
			oldOutputChannel.appendLine(`${getTimestamp()}  [info] ===========================================`);
			oldOutputChannel.appendLine(`${getTimestamp()}  [info] =================NEW LOG===================`);
			oldOutputChannel.appendLine(`${getTimestamp()}  [info] ===========================================`);
			oldOutputChannel.appendLine(``);
			outputChannel = oldOutputChannel;
		} else {
			outputChannel = vscode.window.createOutputChannel(name);
		}

		if (show) {
			outputChannel.show();
		}
		this._outputsByName.set(name, outputChannel);
		this._connectionOutputs.set(connection, outputChannel);
		this._outputsForConnection.set(outputChannel, connection);

		connection.onDidDisconnect.add(() => {
			this._connectionOutputs.delete(connection);
			this._outputsForConnection.delete(outputChannel);
			this._identifyInfo.delete(connection);
		});
		connection.onDidReceiveData.add((data:any) => {
			if (data.type === "message") {
				if (data.system) {
					outputChannel.appendLine(`${getTimestamp()}  [${data.level}][${data.system}] ${data.message}`);
				} else {
					outputChannel.appendLine(`${getTimestamp()}  [${data.level}] ${data.message}`);
				}
			}
			if (data.message_type === "lua_error") { // If it is an error, print extra diagnostics.
				outputChannel.appendLine(`${getTimestamp()}  [${data.level}] ${data.lua_callstack}`);
			}
		});
	}

	async identify(connection: StingrayConnection): Promise<any | null> {
		const info = this._identifyInfo.get(connection);
		if (info) {
			return info;
		}

		let onData: (data: any) => void;
		let timeoutId: NodeJS.Timeout;

		const identifyResult = new Promise<any>(async (resolve) => {
			connection.onDidReceiveData.add(onData = (data: any) => {
				if (data.type === "stingray_identify") {
					resolve(data.info);
				}
			});
			timeoutId = setTimeout(resolve, IDENTIFY_TIMEOUT, null);
		});

		connection.sendLua(IDENTIFY_LUA);

		return identifyResult.then((info) => {
			this._identifyInfo.set(connection, info);
		}).finally(() => {
			connection.onDidReceiveData.remove(onData);
			clearTimeout(timeoutId);
		});
	}
}

export const connectionHandler = new ConnectionHandler;