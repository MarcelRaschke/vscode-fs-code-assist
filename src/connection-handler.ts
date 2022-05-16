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

export class ConnectionHandler {
	readonly onConnectionsChanged = new Multicast();
	private _compiler?: StingrayConnection;
	private _game = new Map<number, StingrayConnection>();
	private _connectionOutputs = new Map<StingrayConnection, vscode.OutputChannel>();
	private _identifyInfo = new Map<StingrayConnection, any>();
	private _outputsByName = new Map<string, vscode.OutputChannel>();

	closeAll() {
		this._compiler?.close();
		for (const [_port, game] of this._game) {
			game.close();
		}
	}

	getCompiler() {
		if (!this._compiler || this._compiler.isClosed) {
			const compiler = new StingrayConnection(14032);
			this._compiler = compiler;
			this._addOutputChannel("Stingray Compiler", compiler, true);
		}
		return this._compiler;
	}

	getGame(port:number, ip?:string) {
		let game = this._game.get(port);
		if (!game || game.isClosed) {
			const newGame = new StingrayConnection(port, ip);

			this._addOutputChannel(`Stingray (${port})`, newGame, true);

			let connected = false;
			newGame.onDidConnect.add(() => {
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

	_addOutputChannel(name:string, connection:StingrayConnection, show: boolean = true) {
		let outputChannel: vscode.OutputChannel;
		connection.onDidConnect.add(() => {
			let oldOutputChannel = this._outputsByName.get(name);
			if (oldOutputChannel) {
				oldOutputChannel.appendLine(``);
				oldOutputChannel.appendLine(`=======================================`);
				oldOutputChannel.appendLine(`=============== NEW LOG ===============`);
				oldOutputChannel.appendLine(`=======================================`);
				oldOutputChannel.appendLine(``);
				outputChannel = oldOutputChannel;
			} else {
				outputChannel = vscode.window.createOutputChannel(name);
			}

			if (show) {
				outputChannel.show();
			}
			this._connectionOutputs.set(connection, outputChannel);
			this._outputsByName.set(name, outputChannel);
		});
		connection.onDidDisconnect.add(() => {
			this._connectionOutputs.delete(connection);
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
				outputChannel.appendLine(data.lua_callstack);
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