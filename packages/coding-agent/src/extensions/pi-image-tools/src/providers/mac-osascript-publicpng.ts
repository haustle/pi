import {
	type ClipboardReadResult,
	type CommandExists,
	type CommandResult,
	type CommandRunner,
	NamespacedCommandProvider,
	providerImageResult,
} from "./provider-helpers.js";

const PUBLIC_PNG_SCRIPT = `ObjC.import('AppKit');
const pasteboard = $.NSPasteboard.generalPasteboard;
const data = pasteboard.dataForType('public.png');
if (!data) {
  $.exit(2);
}
$.NSFileHandle.fileHandleWithStandardOutput.writeData(data);`;

export interface OsascriptPublicPngProviderOptions {
	priority?: number;
	commandRunner?: CommandRunner;
	commandExists?: CommandExists;
}

export class OsascriptPublicPngProvider extends NamespacedCommandProvider {
	constructor(options: OsascriptPublicPngProviderOptions = {}) {
		super(
			{
				id: "mac-osascript-public-png",
				name: "osascript public.png",
				platforms: ["darwin"],
				priority: options.priority ?? 20,
			},
			"osascript",
			options,
		);
	}

	protected buildArgs(): readonly string[] {
		return ["-l", "JavaScript", "-e", PUBLIC_PNG_SCRIPT];
	}

	protected readFromResult(result: CommandResult): ClipboardReadResult {
		return providerImageResult(new Uint8Array(result.stdout), "image/png");
	}
}
