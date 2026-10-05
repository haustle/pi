import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import messageFocusExtension from "./message-focus/index.ts";
import imageToolsExtension from "./pi-image-tools/src/index.ts";
import threadsExtension from "./threads/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "pi-image-tools", factory: imageToolsExtension },
	{ name: "message-focus", factory: messageFocusExtension },
	{ name: "threads", factory: threadsExtension },
];
