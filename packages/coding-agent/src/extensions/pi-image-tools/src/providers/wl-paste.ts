import { CommandRunnerProvider, providerEmptyImage, providerImageResult, providerUnavailable, LIST_TYPES_TIMEOUT_MS, parseMimeTypeList, type CommandRunnerProviderOptions, type ClipboardProviderContext, type ClipboardReadResult } from "./provider-helpers.js";
import { normalizeMimeType, selectPreferredImageMimeType } from "../image-mime.js";

export class WlPasteProvider extends CommandRunnerProvider {
  constructor(options: CommandRunnerProviderOptions = {}) {
    super(
      {
        id: "wl-paste",
        name: "wl-paste",
        platforms: ["linux"],
        priority: options.priority ?? 10,
      },
      options,
    );
  }

  read(context: ClipboardProviderContext): ClipboardReadResult {
    const listTypes = this.runCommand("wl-paste", ["--list-types"], context, LIST_TYPES_TIMEOUT_MS);
    if (listTypes.missingCommand) {
      return providerUnavailable();
    }

    if (!listTypes.ok) {
      return providerEmptyImage();
    }

    const mimeTypes = parseMimeTypeList(listTypes.stdout);

    const selectedMimeType = selectPreferredImageMimeType(mimeTypes);
    if (!selectedMimeType) {
      return providerEmptyImage();
    }

    const imageData = this.runCommand(
      "wl-paste",
      ["--type", selectedMimeType, "--no-newline"],
      context,
    );

    if (!imageData.ok || imageData.stdout.length === 0) {
      return providerEmptyImage();
    }

    return providerImageResult(new Uint8Array(imageData.stdout), normalizeMimeType(selectedMimeType));
  }
}
