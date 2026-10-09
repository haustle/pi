import {
	type ClipboardReadResult,
	type CommandExists,
	type CommandResult,
	type CommandRunner,
	NamespacedCommandProvider,
	providerImageResult,
} from "./provider-helpers.js";

export interface PngpasteProviderOptions {
	priority?: number;
	commandRunner?: CommandRunner;
	commandExists?: CommandExists;
}

export class PngpasteProvider extends NamespacedCommandProvider {
	constructor(options: PngpasteProviderOptions = {}) {
		super(
			{
				id: "mac-pngpaste",
				name: "pngpaste",
				platforms: ["darwin"],
				priority: options.priority ?? 10,
			},
			"pngpaste",
			options,
		);
	}

	protected buildArgs(): readonly string[] {
		return ["-"];
	}

	protected readFromResult(result: CommandResult): ClipboardReadResult {
		return providerImageResult(new Uint8Array(result.stdout), "image/png");
	}
}
