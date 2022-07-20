import { join as pathJoin, basename as pathBaseName, dirname as pathDirName } from "path";
import * as vscode from "vscode";
import { connectionHandler } from "./connection-handler";
import { StingrayConnection } from "./stingray-connection";
import { getActiveToolchain } from "./toolchain";
import { getTimestamp, uuid4 } from "./utils/functions";
import type { Platform } from "./utils/stingray-config";
import { StingrayToolchain } from "./utils/stingray-toolchain";
import { applyStyle } from "./utils/text-styling";

// Documentation links:
// https://code.visualstudio.com/docs/editor/tasks
// https://github.com/microsoft/vscode-extension-samples/blob/main/task-provider-sample
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/tasks/common/problemMatcher.ts

const TASK_SOURCE = "hydra";

/** Schema for a Stingray compile task.
 * Must be kept in sync with the "taskDefinitions" in the package.json file.
 */
type StingrayTaskDefinition = {
	type: typeof TASK_SOURCE,
	/** Target platform to compile for. */
	platform: Platform;
	/** If true, the result will be bundled. */
	bundle?: boolean;
	/** If true, on a successful compile all connected game instances will be reloaded. */
	refresh?: boolean;
	/** An optional list of filesystem patterns to watch. */
	watch?: string[];
};

enum StatusCode {
	Success = 0,
	Error = 1,
	Disconnect = 2,
}

class StingrayCompileTaskTerminal implements vscode.Pseudoterminal {
	private writeEmitter = new vscode.EventEmitter<string>();
	onDidWrite: vscode.Event<string> = this.writeEmitter.event;
	private closeEmitter = new vscode.EventEmitter<number>();
	onDidClose: vscode.Event<number> = this.closeEmitter.event;

	private id: string = "<not set>";
	private compilerClose: Function | null = null;

	constructor(
		private toolchain: StingrayToolchain,
		private definition: StingrayTaskDefinition,
	) {
	}

	open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
		this.startCompile();
	}

	close(): void {
		this.doClose();
	}

	private doClose(code?: StatusCode) {
		if (this.compilerClose) {
			this.compilerClose();
		}

		if (code !== undefined) {
			this.closeEmitter.fire(code);
		}
	}

	private write(type: string, message: string) {
		const timestamp = applyStyle(getTimestamp(), "2");
		if (type === "StingrayCompile" || type === "compiler") {
			message = applyStyle(message, "1");
		} else if (type === "compile_progress" || type === "compile_done") {
			message = applyStyle(message, "3");
		}
		this.writeEmitter.fire(`${timestamp}  ${message.replace(/\n/g, '\r\n')}\r\n`);
	}

	private static level2style: { [level: string]: string } = {
		info: "34",
		warning: "33",
		error: "31",
		command: "35",
	};

	private async startCompile() {
		const { toolchain, definition } = this;
		const platform = definition.platform;

		const compiler = await connectionHandler.connectToCompiler();
		if (compiler.isClosed) {
			this.write("HydraCompile", `Could not connect to compile server at ${compiler.ip}:${compiler.port}.`);
			this.doClose(StatusCode.Error);
			return;
		}

		let compileInProgress = false;

		const onData = (data: any) => {
			if (data.type === "compiler" && data.id === this.id) {
				if (data.start) {
					this.write("compiler", "Compilation started.");
					//this.compileInProgress = true; // Set when requested.
				} else if (data.finished) {
					this.write("compiler", "Compilation finished.");
					const success = data.status === "success";
					if (this.definition.refresh && success) {
						vscode.commands.executeCommand('toadman-code-assist.Connection.reloadResources');
					}
					compileInProgress = false;
					this.doClose(success ? StatusCode.Success : StatusCode.Error);
				}
			} else if (data.type === "compile_progress" && !data.done) {
				// Note: data.file is not necessarily a file.
				const count = data.count.toString();
				const i = (data.i + 1).toString().padStart(count.length, " ");
				const progress = applyStyle(`[progress]`, "33");
				const file = applyStyle(`${data.file ?? "<unknown file>"}`, "3");
				this.write("compile_progress", `${progress} ${i} / ${count} ${file}`);
			} else if (data.type === "compile_progress" && data.done) {
				this.write("compile_done", `status=${data.status}, file=${data.file}`);
			} else if (data.type === "c") {
				this.write("compile_done", `status=${data.status}, file=${data.file}`);
			} else if (data.type === "message") {
				let message = data.message;
				if (/^Error compiling `([^`]+)`/.test(message)) {
					// This is a hack so we can capture the error message in the same line as the file.
					message = message.replace(/\n\n/, ": ");
				}
				if (data.error_context) {
					message += `\n${data.error_context}`;
				}
				const level = applyStyle(`[${data.level}]`, StingrayCompileTaskTerminal.level2style[data.level] ?? "0");
				if (data.system) {
					this.write("message", `${level}[${data.system}] ${message}`);
				} else {
					this.write("message", `${level} ${message}`);
				}
			}
		};
		const onDisconnect = () => {
			this.write("HydraCompile", `Lost connection to ${compiler.ip}:${compiler.port}.`);
			this.doClose(StatusCode.Disconnect);
		};
		compiler.onDidReceiveData.add(onData);
		compiler.onDidDisconnect.add(onDisconnect);

		this.compilerClose = () => {
			if (compileInProgress && compiler.isReady) {
				compiler.sendJSON({
					"id": this.id,
					"type" : "cancel",
				});
				compileInProgress = false;
			}
			compiler.onDidReceiveData.remove(onData);
			compiler.onDidDisconnect.remove(onDisconnect);
		};

		const config = await toolchain.config();
		const currentProject = config.Projects[config.ProjectIndex];
		const sourceDir = currentProject.SourceDirectory;
		const dataDir = pathJoin(currentProject.DataDirectoryBase, platform);

		this.id = uuid4();

		const sourceDirectoryMaps = [];
		for(const mappedFolder of currentProject.MappedFolders) {
			const folderName = pathBaseName(mappedFolder);
			const folderPath = pathDirName(mappedFolder);
			sourceDirectoryMaps.push({ "directory": folderName, "root" : folderPath });
		}

		const compileMessage: any = {
			"id": this.id,
			"type": "compile",
			"source-directory": sourceDir,
			"source-directory-maps": sourceDirectoryMaps,
			"data-directory": dataDir,
			"source-platform": platform,
			"destination-platform": "win32",
		};

		if (definition.bundle) {
			let bundleDir = (platform !== "win32")
				? `${platform}_bundled`
				: `win32_${platform}_bundled`;
			compileMessage["bundle-directory"] = pathJoin(currentProject.DataDirectoryBase, bundleDir);
		}

		compileInProgress = true;
		compiler.sendJSON(compileMessage);
		this.write("HydraCompile", `Compilation requested with id ${this.id}.`);
	}
}


const createExecution = (toolchain: StingrayToolchain, definition: StingrayTaskDefinition) => {
	return new vscode.CustomExecution(
		async (_resolvedDefinition: vscode.TaskDefinition): Promise<vscode.Pseudoterminal> => {
			return new StingrayCompileTaskTerminal(toolchain, definition);
		}
	);
};

const DEFAULT_PROBLEM_MATCHERS = [
	"$hydra-build-lua-error",
	"$hydra-build-parse-error",
	"$hydra-build-sjson-error",
	"$hydra-build-generic-error",
];

export const createDefaultTask = (toolchain: StingrayToolchain, platform: Platform) => {
	const definition: StingrayTaskDefinition = {
		type: TASK_SOURCE,
		platform,
	};
	return new vscode.Task(
		definition,
		vscode.TaskScope.Workspace, // Should be Global, but currently not supported.
		`compile for ${platform}`,
		TASK_SOURCE,
		createExecution(toolchain, definition),
		DEFAULT_PROBLEM_MATCHERS
	);
};

export const activate = (context: vscode.ExtensionContext) => {
	context.subscriptions.push(vscode.tasks.registerTaskProvider(TASK_SOURCE, {
		// Provide a task for each platform.
		async provideTasks(_token: vscode.CancellationToken): Promise<vscode.Task[]> {
			const toolchain = getActiveToolchain();
			if (!toolchain) {
				return [];
			}
			const config = await toolchain.config();
			return config.Targets.map((target) => {
				return createDefaultTask(toolchain, target.Platform);
			});
		},
		// Check that the task is valid, and if it is fill out the execution field.
		async resolveTask(task: vscode.Task, _token: vscode.CancellationToken): Promise<vscode.Task | undefined> {
			const toolchain = getActiveToolchain();
			if (!toolchain) {
				return undefined;
			}
			const definition = task.definition;
			if (definition.type !== TASK_SOURCE) {
				return undefined; // Invalid task definition.
			}
			
			const compiler = await connectionHandler.connectToCompiler();
			if (!compiler) {
				return undefined;
			}
			return new vscode.Task(
				definition, // Must be unchanged according to the docs.
				vscode.TaskScope.Workspace, // Can be undefined for some reason?
				task.name,
				task.source,
				createExecution(toolchain, definition as StingrayTaskDefinition),
				task.problemMatchers.length > 0 ? task.problemMatchers : DEFAULT_PROBLEM_MATCHERS
			);
		},
	}));
};
