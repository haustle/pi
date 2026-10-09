import { spawnSync } from "node:child_process";

import { isErrnoException } from "../errors.js";

export const LIST_TYPES_TIMEOUT_MS = 1000;
export const READ_TIMEOUT_MS = 5000;
export const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

const ALLOWED_CLIPBOARD_COMMANDS = new Set([
	"osascript",
	"pngpaste",
	"reattach-to-user-namespace",
	"wl-paste",
	"xclip",
]);

export interface CommandResult {
	ok: boolean;
	stdout: Buffer;
	stderr: Buffer;
	missingCommand: boolean;
	status: number | null;
}

export interface CommandRunOptions {
	environment?: NodeJS.ProcessEnv;
	maxBuffer?: number;
	timeout: number;
	windowsHide?: boolean;
}

export type CommandRunner = (command: string, args: readonly string[], options: CommandRunOptions) => CommandResult;

function toBuffer(value: unknown): Buffer {
	if (Buffer.isBuffer(value)) {
		return value;
	}

	if (value instanceof Uint8Array) {
		return Buffer.from(value);
	}

	return Buffer.from(value === undefined || value === null ? "" : String(value), "utf8");
}

export const defaultCommandRunner: CommandRunner = (command, args, options) => {
	if (!ALLOWED_CLIPBOARD_COMMANDS.has(command.trim().toLowerCase())) {
		return {
			ok: false,
			stdout: Buffer.alloc(0),
			stderr: Buffer.from(`Command is not allowlisted for clipboard image providers: ${command}`),
			missingCommand: false,
			status: null,
		};
	}

	const result = spawnSync(command, [...args], {
		// nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- command is checked against ALLOWED_CLIPBOARD_COMMANDS immediately above; provider args are fixed arrays and shell is disabled.
		env: options.environment,
		maxBuffer: options.maxBuffer ?? MAX_BUFFER_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: options.timeout,
		windowsHide: options.windowsHide,
	});

	if (result.error) {
		return {
			ok: false,
			stdout: toBuffer(result.stdout),
			stderr: toBuffer(result.stderr),
			missingCommand: isErrnoException(result.error) && result.error.code === "ENOENT",
			status: result.status ?? null,
		};
	}

	return {
		ok: result.status === 0,
		stdout: toBuffer(result.stdout),
		stderr: toBuffer(result.stderr),
		missingCommand: false,
		status: result.status ?? null,
	};
};
