import {
	type ClipboardReadResult,
	type CommandExists,
	type CommandResult,
	type CommandRunner,
	NamespacedCommandProvider,
	providerEmptyImage,
	providerImageResult,
} from "./provider-helpers.js";

const PNGF_SCRIPT = `try
  set imageData to the clipboard as «class PNGf»
  return imageData
on error
  return ""
end try`;

export interface OsascriptPngfProviderOptions {
	priority?: number;
	commandRunner?: CommandRunner;
	commandExists?: CommandExists;
}

function parseAppleScriptPngfData(stdout: Buffer): Uint8Array | null {
	const text = stdout.toString("utf8").trim();
	if (text.length === 0) {
		return null;
	}

	const match = text.match(/«data\s+PNGf([0-9a-fA-F\s]+)»/i);
	if (!match) {
		return null;
	}

	const hex = match[1]?.replace(/\s+/g, "") ?? "";
	if (hex.length === 0 || hex.length % 2 !== 0) {
		return null;
	}

	const bytes = Buffer.from(hex, "hex");
	return bytes.length > 0 ? new Uint8Array(bytes) : null;
}

export class OsascriptPngfProvider extends NamespacedCommandProvider {
	constructor(options: OsascriptPngfProviderOptions = {}) {
		super(
			{
				id: "mac-osascript-pngf",
				name: "osascript PNGf",
				platforms: ["darwin"],
				priority: options.priority ?? 30,
			},
			"osascript",
			options,
		);
	}

	protected buildArgs(): readonly string[] {
		return ["-e", PNGF_SCRIPT];
	}

	protected readFromResult(result: CommandResult): ClipboardReadResult {
		const bytes = parseAppleScriptPngfData(result.stdout);
		if (!bytes) {
			return providerEmptyImage();
		}

		return providerImageResult(bytes, "image/png");
	}
}
