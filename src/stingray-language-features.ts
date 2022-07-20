import { basename } from "path";
import path = require("path");
import * as vscode from "vscode";
import {} from "vscode-languageserver";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { activate as activateAdocAutocomplete } from './adoc-autocomplete';
import { RawSymbolInformation, TaskRunner } from "./project-symbol-indexer";
import { formatCommand } from "./utils/vscode";

const LANGUAGE_SELECTOR = "lua";

class StingrayLuaLanguageServer {
	private _initialized = false;
	private _symbols = new Map<String, vscode.SymbolInformation[]>();
	private _textures = new Map<String, vscode.Uri>();

	constructor() {
		vscode.workspace.onWillSaveTextDocument(this.onWillSaveTextDocument.bind(this));
	}

	pushSymbolData(symbol: RawSymbolInformation) {
		const { name, path, line, char, kind, parent } = symbol;
		let list = this._symbols.get(name);
		if (!list) {
			list = [];
			this._symbols.set(name, list);
		}
		const location = new vscode.Location(vscode.Uri.file(path), new vscode.Position(line, char));
		list.push(new vscode.SymbolInformation(name, vscode.SymbolKind[kind], parent || "", location));
	}

	async symbols() {
		await this._ensureInitialized();
		return this._symbols;
	}

	async textures() {
		await this._ensureInitialized();
		return this._textures;
	}

	async _ensureInitialized() {
		if (!this._initialized) {
			this._initialized = true;
			await this.parseLuaFiles();
			await this.indexTextureFiles();
		}
	}

	async parseLuaFiles(files?: string[], token?: vscode.CancellationToken) {
		if (!files) {
			const uris = await vscode.workspace.findFiles("{foundation,scripts,core}/**/*.lua");
			files = uris.map((uri) => uri.fsPath);
		}
		const indexer = new TaskRunner("parseFileSymbols", files, this.pushSymbolData.bind(this));
		token?.onCancellationRequested(() => {
			indexer.abort();
		});
		try {
			const elapsed = await indexer.run();
			if (files.length > 1) {
				vscode.window.showInformationMessage(`Indexed ${files.length} files in ${Math.floor(elapsed)} ms using up to ${indexer.threadCount} worker threads.`);
			}
		} catch (e) {
			vscode.window.showErrorMessage((e as Error).message);
		}
	}

	async indexTextureFiles() {
		const uris = await vscode.workspace.findFiles("{.gui_source_textures,gui/1080p/single_textures}/**/*.png");
		for (const uri of uris) {
			this._textures.set(basename(uri.path, ".png"), uri);
		}
	}

	onWillSaveTextDocument(event: vscode.TextDocumentWillSaveEvent) {
		if (event.document.languageId === "lua") {
			this.parseLuaFiles([ event.document.uri.fsPath ]);
		}
	}
}

function startLanguageServer(context: vscode.ExtensionContext) {
    const serverModule = path.join(__dirname, '../out/languageserver', 'server.js');

    const debugOptions = {
        execArgv: ['--nolazy', '--inspect=6009'], env: {
            NODE_ENV: 'development'
        }
    };

    const runOptions = {
        env: {
            NODE_ENV: 'production'
        }
    };

    let serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc, options: runOptions },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            // The current version of node shipped with VSCode Insiders (as of April 3 2017) seems to have an issue with
            // --inspect debugging, so we'll assume that someone debugging the extension has a recent version of node on
            // on their PATH.
            // If you do not, comment this line out and replace the --inspect above with --debug.
            runtime: 'node',
            options: debugOptions
        }
    };

    const serverCommand = vscode.workspace.getConfiguration().get('lua.server.command') as string;
    if (serverCommand) {
        const serverArgs = vscode.workspace.getConfiguration().get('lua.server.args') as string[];
        serverOptions = {
            command: serverCommand, args: serverArgs
        };
    }

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        // Register the server for plain text documents
        documentSelector: [
            { language: 'lua', scheme: 'file' },
            { language: 'lua', scheme: 'untitled' }
        ],
        synchronize: {
            configurationSection: [
                'lua',
				'Hydra'
            ]
        }
    };

    // Create the language client and start the client.
    const languageClient = new LanguageClient('luaLanguageServer',
        'Lua Language Server', serverOptions, clientOptions);

	languageClient.start();

	context.subscriptions.push({
		dispose: () => {
			languageClient.stop();
		}
	});
}


export function activate(context: vscode.ExtensionContext) {
	const server = new StingrayLuaLanguageServer();
	
    startLanguageServer(context);

	context.subscriptions.push(vscode.languages.registerDefinitionProvider(LANGUAGE_SELECTOR, {
		async provideDefinition(document, position) {
			const wordRange = document.getWordRangeAtPosition(position, /[\w_]+/);
			if (!wordRange) {
				return undefined;
			}
			const word = document.getText(wordRange);
			const symbols = await server.symbols();
			return symbols.get(word)?.map((sym) => sym.location);
		}
	}));

	context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
		async provideWorkspaceSymbols(query) {
			const symbols = await server.symbols();
			query = query.toLowerCase();
			return Array.from(symbols.values()).flatMap((list) => list);
		}
	}));


	type MethodData = {
		name: string;
		args: string[];
	};

	const methodList: MethodData[] = [];

	const CLASS_REGEX = /^(\w+)\s*=\s*class/;
	const OBJECT_REGEX = /^(\w+)\s*=\s*\1/;
	const METHOD_REGEX = /^function\s+(\w+)[:.]([\w_]+)\(([^)]*)\)/;
	const FUNCTION_REGEX = /^function\s+([\w_]+)\(/;
	const ENUM_REGEX = /([\w_]+)\s*=\s*table\.enum\(/;
	const CONST_REGEX = /^(?:local\s+)?([A-Z_]+)\s*=/;
	const LOCAL_REGEX = /^local(?:\s+function)?\s+([\w_]+)\b/;
	context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(LANGUAGE_SELECTOR, {
		provideDocumentSymbols(document, _token) {
			const symbols = [];
			const symbolLookup = new Map<string, vscode.DocumentSymbol>();

			methodList.length = 0; // Clear the array, JavaScript style.

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;
				const range = new vscode.Range(i, 0, i, 0);
				const selectionRange = new vscode.Range(i, 0, i, 0);

				const methodMatches = METHOD_REGEX.exec(text);
				if (methodMatches) {
					const [_, mClass, mMethod, mArgs] = methodMatches;
					const kind = (mMethod === "init") ? vscode.SymbolKind.Constructor : vscode.SymbolKind.Method;
					const symbol = new vscode.DocumentSymbol(mMethod, mClass, kind, range, selectionRange);
					const parent = symbolLookup.get(mClass);
					if (parent) {
						parent.children.push(symbol);
					} else {
						symbols.push(symbol);
					}
					methodList.push({
						name: mMethod,
						args: mArgs.split(/\s*,\s*/),
					});
					continue;
				}

				const functionMatches = FUNCTION_REGEX.exec(text);
				if (functionMatches) {
					const [_, mFunc] = functionMatches;
					symbols.push(new vscode.DocumentSymbol(mFunc, "", vscode.SymbolKind.Function, range, selectionRange));
					continue;
				}

				const classMatches = CLASS_REGEX.exec(text);
				if (classMatches) {
					const [_, mClass] = classMatches;
					const symbol = new vscode.DocumentSymbol(mClass, "", vscode.SymbolKind.Class, range, selectionRange);
					symbols.push(symbol);
					symbolLookup.set(mClass, symbol);
					continue;
				}

				const objectMatches = OBJECT_REGEX.exec(text);
				if (objectMatches) {
					const [_, mObj] = objectMatches;
					const symbol = new vscode.DocumentSymbol(mObj, "", vscode.SymbolKind.Object, range, selectionRange);
					symbols.push(symbol);
					symbolLookup.set(mObj, symbol);
					continue;
				}

				const enumMatches = ENUM_REGEX.exec(text);
				if (enumMatches) {
					const [_, mEnum] = enumMatches;
					symbols.push(new vscode.DocumentSymbol(mEnum, "", vscode.SymbolKind.Enum, range, selectionRange));
					continue;
				}

				const constMatches = CONST_REGEX.exec(text);
				if (constMatches) {
					const [_, mConst] = constMatches;
					symbols.push(new vscode.DocumentSymbol(mConst, "", vscode.SymbolKind.Constant, range, selectionRange));
					continue;
				}

				const localMatches = LOCAL_REGEX.exec(text);
				if (localMatches) {
					const [_, mLocal] = localMatches;
					symbols.push(new vscode.DocumentSymbol(mLocal, "", vscode.SymbolKind.Variable, range, selectionRange));
					continue;
				}
			}
			return symbols;
		}
	}));

	const COLOR_REGEX = /\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/d;
	context.subscriptions.push(vscode.languages.registerColorProvider(LANGUAGE_SELECTOR, {
		provideColorPresentations(color, _context, _token) {
			const cA = (255*color.alpha).toFixed(0);
			const cR = (255*color.red).toFixed(0);
			const cG = (255*color.green).toFixed(0);
			const cB = (255*color.blue).toFixed(0);
			const presentation = new vscode.ColorPresentation(`{${cA},${cR},${cG},${cB}}`);
			// presentation.textEdit = new TextEdit()
			return [ presentation ];
		},
		provideDocumentColors(document, _token) {
			const colors = [];

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				const colorMatches = COLOR_REGEX.exec(text);
				if (colorMatches) {
					const [_, cA, cR, cG, cB] = colorMatches;
					const color = new vscode.Color(parseInt(cR, 10)/255, parseInt(cG, 10)/255, parseInt(cB, 10)/255, parseInt(cA, 10)/255);
					const indices = (<any> colorMatches).indices; // Ugly hack to shut up TypeScript.
					const range = new vscode.Range(i, indices[0][0], i, indices[0][1]);
					colors.push(new vscode.ColorInformation(range, color));
				}
			}

			return colors;
		}
	}));

	// Texture preview.
	context.subscriptions.push(vscode.languages.registerHoverProvider(LANGUAGE_SELECTOR, {
		async provideHover(document, position) {
			const { text } = document.lineAt(position);
			let startPos = -1;
			for (let i = position.character-1; i > -1; --i) {
				const char = text[i];
				if (char === '"') {
					startPos = i + 1;
					break;
				} else if (!/\w/.test(char)) {
					return;
				}
			}
			let endPos = -1;
			for (let j = position.character; j < text.length; ++j) {
				const char = text[j];
				if (char === '"') {
					endPos = j;
					break;
				} else if (!/\w/.test(char)) {
					return;
				}
			}
			if (startPos === -1 || endPos === -1) {
				return;
			}
			const hoverRange = new vscode.Range(
				new vscode.Position(position.line, startPos),
				new vscode.Position(position.line, endPos)
			);
			const path = text.substring(startPos, endPos);
			const textures = await server.textures();
			const uri = textures.get(path);
			if (!uri) {
				return;
			}
			const mdString = new vscode.MarkdownString();
			mdString.supportHtml = true;
			mdString.isTrusted = true;
			const openExternalUri = formatCommand('toadman-code-assist._goToResource', {
				external: true,
				file: uri.fsPath,
			});
			const openVSCodeUri = formatCommand('toadman-code-assist._goToResource', {
				external: false,
				file: uri.fsPath,
			});
			mdString.appendCodeblock(path, 'plaintext');
			mdString.appendMarkdown([
				`---`,
				`\n<img src='${uri.toString()}'>\n`,
				`---`,
				`[Open externally](${openExternalUri}) | [Open in VSCode](${openVSCodeUri})`,
			].join('\n'));
			return new vscode.Hover(mdString, hoverRange);
		}
	}));

	activateAdocAutocomplete(context);

	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(LANGUAGE_SELECTOR, {
		async provideCompletionItems(document, position, _token, _context) {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				return;
			}
			const { text } = document.lineAt(position);
			let endPos;
			for (endPos = position.character-1; endPos > -1; --endPos) {
				const char = text[endPos];
				if (char === '"') {
					return;
				} else if (char === '/') {
					break;
				}
			}
			let startPos = -1;
			for (startPos = endPos-1; startPos > -1; --startPos) {
				const char = text[startPos];
				if (char === '"') {
					++startPos;
					break;
				} else if (!/[\w/]/.test(char)) {
					return;
				}
			}
			if (startPos < 0) {
				return;
			}
			const base = text.slice(startPos, endPos);
			const uri = vscode.Uri.joinPath(folder.uri, base);
			const fileTuples = await vscode.workspace.fs.readDirectory(uri);
			const completions: vscode.CompletionItem[] = [];
			fileTuples.forEach(([fileName, fileType]) => {
				if (fileName.endsWith('.processed')) {
					return;
				}
				const kind = fileType === vscode.FileType.Directory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File;
				const label = fileName.split('.')[0];
				const item = new vscode.CompletionItem(label, kind);
				item.detail = fileName;
				completions.push(item);
			});
			return completions;
		}
	}, '/'));

	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(LANGUAGE_SELECTOR, {
		provideCompletionItems(document, position, _token, _context) {
			const range = new vscode.Range(position.line, position.character-5, position.line, position.character-1);
			const word = document.getText(range);
			if (word !== "self") {
				return null;
			}
			return methodList.map((method) => {
				const item = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Function);
				item.detail = "(method)";
				//item.documentation = "Tell me if you can see this.";
				return item;
			});
		}
	}, ":"));

	const LUA_LINK_REGEX = /@?([\w/]+\.lua)(?::(\d+))?\b/d;
	const RESOURCE_LINK_REGEX = /\[(\w+) '([\w/]+)'\]/d;
	const COMMAND_LINK_REGEX = /\[(command\:[\w-_]+[.\w-_]+)\]/gd;
	context.subscriptions.push(vscode.languages.registerDocumentLinkProvider("stingray-output", {
		provideDocumentLinks(document, _token) {
			const links: vscode.DocumentLink[] = [];

			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				return links;
			}
			const rootUri = folder.uri.fsPath;

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				const luaMatches = LUA_LINK_REGEX.exec(text);
				if (luaMatches) {
					const indices = (<any> luaMatches).indices;
					const range = new vscode.Range(i, indices[0][0], i, indices[0][1]);
					const commandUri = formatCommand('toadman-code-assist._goToResource', {
						external: false,
						file: `${rootUri}/${luaMatches[1]}`,
						line: luaMatches[2] ? parseInt(luaMatches[2], 10) : 1,
					});
					const link = new vscode.DocumentLink(range, commandUri);
					link.tooltip = 'Open in VSCode';
					links.push(link);
					continue;
				}

				const resMatches = RESOURCE_LINK_REGEX.exec(text);
				if (resMatches) {
					const indices = (<any> resMatches).indices;
					const range = new vscode.Range(i, indices[0][0], i, indices[0][1]);
					const commandUri = formatCommand('toadman-code-assist._goToResource', {
						external: true,
						file: `${rootUri}/${resMatches[2]}.${resMatches[1].toLowerCase()}`,
					});
					const link = new vscode.DocumentLink(range, commandUri);
					link.tooltip = 'Open externally';
					links.push(link);
					continue;
				}

				let commandMatch;
				while ((commandMatch = COMMAND_LINK_REGEX.exec(text)) !== null) {
					const index = commandMatch.index;
					const lastIndex = COMMAND_LINK_REGEX.lastIndex;
					const range = new vscode.Range(i, index, i, lastIndex);
					const command = commandMatch[1];
	
					const commandUri = vscode.Uri.parse(command);
					const link = new vscode.DocumentLink(range, commandUri);
					link.tooltip = 'Run Command';
					links.push(link);
				}
			}

			return links;
		}
	}));
}

/* Putting these links here as a dirty scratchpad:
https://regex101.com/
https://github.com/winlibs/oniguruma/blob/master/doc/RE
https://www.regular-expressions.info/lookaround.html
https://github.com/microsoft/vscode/blob/1e810cafb7461ca077c705499408ca838524c014/extensions/theme-monokai/themes/monokai-color-theme.json
*/