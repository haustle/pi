import { normalizeMimeType, SUPPORTED_IMAGE_MIME_TYPES, selectPreferredImageMimeType } from "../image-mime.js";
import {
	type ClipboardProviderContext,
	type ClipboardReadResult,
	CommandRunnerProvider,
	type CommandRunnerProviderOptions,
	LIST_TYPES_TIMEOUT_MS,
	parseMimeTypeList,
	providerEmptyImage,
	providerImageResult,
	providerUnavailable,
} from "./provider-helpers.js";

export class XclipProvider extends CommandRunnerProvider {
	constructor(options: CommandRunnerProviderOptions = {}) {
		super(
			{
				id: "xclip",
				name: "xclip",
				platforms: ["linux"],
				priority: options.priority ?? 20,
			},
			options,
		);
	}

	read(context: ClipboardProviderContext): ClipboardReadResult {
		const targets = this.runCommand(
			"xclip",
			["-selection", "clipboard", "-t", "TARGETS", "-o"],
			context,
			LIST_TYPES_TIMEOUT_MS,
		);

		if (targets.missingCommand) {
			return providerUnavailable();
		}

		const advertisedMimeTypes = targets.ok ? parseMimeTypeList(targets.stdout) : [];

		const preferredMimeType =
			advertisedMimeTypes.length > 0 ? selectPreferredImageMimeType(advertisedMimeTypes) : null;
		const mimeTypesToTry = preferredMimeType
			? [preferredMimeType, ...SUPPORTED_IMAGE_MIME_TYPES]
			: [...SUPPORTED_IMAGE_MIME_TYPES];

		for (const mimeType of mimeTypesToTry) {
			const imageData = this.runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"], context);

			if (imageData.ok && imageData.stdout.length > 0) {
				return providerImageResult(new Uint8Array(imageData.stdout), normalizeMimeType(mimeType));
			}
		}

		return providerEmptyImage();
	}
}
