import * as vscode from 'vscode';
import { StingrayToolchain } from './utils/stingray-toolchain';

export const getToolchainPath = (): string|null|undefined => {
	const config = vscode.workspace.getConfiguration('Hydra');
	const binariesPath: string|null|undefined = config.get('binariesPath');
	return binariesPath;
};

let _activeToolchain: StingrayToolchain | null | undefined;
let _toolchainPath: string | null | undefined;

export const getActiveToolchain = () => {
	const newToolchainPath = getToolchainPath();
	if (_activeToolchain && _toolchainPath === newToolchainPath) {
		return _activeToolchain;
	}

	_activeToolchain = null;
	_toolchainPath = newToolchainPath;
	
	if (!newToolchainPath) {
		return null;
	}

	try {
		_activeToolchain = new StingrayToolchain(newToolchainPath);
	} catch (err) {
		return null;
	}
	
	return _activeToolchain;
};
