import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { deleteKittyImage, encodeKitty, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { type Component, imageLineRowSpan, type TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const IMAGE_ID = 4242;
const IMAGE_ROWS = 5;

/**
 * Full-height content whose image sits near the vertical center, so a centered overlay
 * covers it. The image reserves multiple rows via trailing blank placeholder lines.
 */
class ImageContent implements Component {
	render(): string[] {
		const image = encodeKitty("QUJD", { columns: 10, rows: IMAGE_ROWS, imageId: IMAGE_ID });
		const lines: string[] = [];
		for (let i = 0; i < 10; i++) lines.push(`Header ${i}`);
		lines.push(image);
		for (let i = 1; i < IMAGE_ROWS; i++) lines.push("");
		lines.push("Footer line");
		return lines;
	}
	invalidate() {}
}

class SimpleOverlay implements Component {
	render(): string[] {
		return ["OVERLAY_TOP", "OVERLAY_MID", "OVERLAY_BOT"];
	}
	invalidate() {}
}

/** VirtualTerminal that records every raw write so we can inspect emitted escape sequences. */
class CapturingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

describe("imageLineRowSpan", () => {
	it("reads the Kitty r= row count", () => {
		const line = encodeKitty("QUJD", { columns: 4, rows: 7, imageId: 1 });
		assert.equal(imageLineRowSpan(line), 7);
	});

	it("defaults to a single row for non-image lines", () => {
		assert.equal(imageLineRowSpan("plain text"), 1);
	});
});

describe("overlay over a terminal-drawn image", () => {
	afterEach(() => resetCapabilitiesCache());

	it("deletes the image placement so it does not float in front of the overlay", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new CapturingTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new ImageContent());
		tui.start();
		await terminal.waitForRender();
		terminal.writes.length = 0;

		// Overlay is centered over a 24-row terminal, so its rows cover the image span.
		tui.showOverlay(new SimpleOverlay());
		await terminal.waitForRender();

		const output = terminal.writes.join("");
		assert.ok(output.includes(deleteKittyImage(IMAGE_ID)), "expected the covered image placement to be deleted");

		const viewport = terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("OVERLAY_MID")),
			"overlay should be visible",
		);

		tui.stop();
	});
});
