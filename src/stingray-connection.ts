import * as WebSocket from 'ws';
import * as utils from './utils/functions';
import Multicast from './utils/multicast';

/** A connection to an engine instance.
 *
 * The instance can be the compiler or a regular game instance.
 */
export class StingrayConnection {
	/** Flag indicating if the connection is ready. */
	public isReady: boolean = false;
	/** Flag indicating if the connection has been closed. */
	public isClosed: boolean = false;
	/** Flag indicating if the connection if an error ocurred. */
	public lastError: Error | null = null;
	/** Event triggered when the connection is established. */
	readonly onDidConnect = new Multicast();
	/** Event triggered when the connection is teared down */
	readonly onDidDisconnect = new Multicast();
	/** Event triggered when data is received. */
	readonly onDidReceiveData = new Multicast();

	private socket: WebSocket;

	constructor(
		/** Port number of the console server. */
		readonly port: number,
		/** IP address of the console server. */
		readonly ip: string = '127.0.0.1'
	) {
		this.socket = new WebSocket("ws://" + ip + ":" + port);
		this.socket.on('close', () => {
			this.isReady = false;
			this.isClosed = true;
			this.onDidDisconnect.fire(this.lastError);
		});
		this.socket.on('open', () => {
			this.isReady = true;
			this.onDidConnect.fire();
		});
		this.socket.on('error', (err: Error) => {
			this.lastError = err;
		});

		this.socket.on('message', (data, isBinary) => {
			if (!isBinary) {
				const jsonString = data.toString('utf8').replace(/\0+$/g, '');
				try {
					const json = JSON.parse(jsonString);
					this.onDidReceiveData.fire(json);
				} catch (err) {
					//TODO - figure out why this happens.
				}
			}
		});
	}

	/** Close the connection. */
	close() {
		this.socket.close();
	}

	/** Send an engine command. */
	sendCommand(command: string, ...args: any) {
		const guid = utils.uuid4();
		this._send({
			id: guid,
			type: 'command',
			command: command,
			arg: [...args]
		});
		return guid;
	}

	/**
	 * Send a debugger command.
	 * @param command Debugger command.
	 * @param data Extra data to send.
	 */
	sendDebuggerCommand(command: string, data?: any) {
		this._send(Object.assign({
			type: 'lua_debugger',
			command,
		}, data));
	}

	/**
	 * Send a JSON object.
	 * @param object Any JSON-serializable object.
	 */
	sendJSON(object: any) {
		this._send(object);
	}

	/**
	 * Send Lua code that will be executed in the engine.
	 * @param script Lua code to execute.
	 */
	sendLua(script: string) {
		this._send({
			type: 'script',
			script,
		});
	}

	private _send(data: any) {
		const payload = JSON.stringify(data);
		this.socket.send(payload);
	}
}