// Handles connections to stingray compile server and game clients.
// Handles creating and hooking to VS Code Output windows.
// Handles "Connected Clients" side panel refreshing.

import * as vscode from 'vscode';
import { ConnectedClientsNodeProvider } from './connected-clients-node-provider';
import { StingrayConnection } from "./stingray-connection";
import { getTimestamp } from './utils';

export const MAX_CONNECTIONS = 16;

export class ConnectionHandler {
    _compiler?: StingrayConnection;
    _game: Map<number, StingrayConnection>;
    _connectionOutputs: Map<StingrayConnection, vscode.OutputChannel>;

    constructor(){
        this._game = new Map();     
        this._connectionOutputs = new Map();
    }

    closeAll() {
        this._compiler?.close();
        for (let [port, game] of this._game) {
            game.close();
        }
    }

    getCompiler() {
        if (!this._compiler || this._compiler.isClosed()) {
            this._compiler = new StingrayConnection(14032);
            this._addOutputChannel("Stingray Compiler", this._compiler);
        }
        return this._compiler;        
    }

    getGame(port:number, ip?:string) {
        let game = this._game.get(port);
        if (!game || game.isClosed()) {
            game = new StingrayConnection(port, ip);
            this._game.set(port, game);
            this._addOutputChannel(`Stingray (${port})`, game);
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
        let allGameConnections = [];
        for (let [port, game] of this._game) {
            if (!game.isClosed()) {
                allGameConnections.push(game);
            }
        }
        return allGameConnections;
    }

    getOutputForConnection(connection:StingrayConnection) {
        return this._connectionOutputs.get(connection);
    }

    _addOutputChannel(name:string, connection:StingrayConnection) {
        const outputChannel = vscode.window.createOutputChannel(name);
        connection.onDidReceiveData.add((response:any) => {
            if (response.message) {
                outputChannel.appendLine(`${getTimestamp()}  [${response.level}][${response.system}] ${response.message}`);
            }
        });
        connection.onDidConnect.add(() => {
            outputChannel.show();
            vscode.commands.executeCommand("fatshark-code-assist._refreshConnectedClients");
        });
        connection.onDidDisconnect.add((hadError:boolean) => {
            // outputChannel.hide();
            // outputChannel.dispose();
            vscode.commands.executeCommand("fatshark-code-assist._refreshConnectedClients");
        });
        this._connectionOutputs.set(connection, outputChannel);
    }
}

export let connectionHandler = new ConnectionHandler;