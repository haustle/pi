import { describe, expect, it } from "vitest";
import { formatThreadTimeBucket } from "../src/modes/interactive/interactive-mode.ts";

describe("formatThreadTimeBucket", () => {
	const now = new Date(2026, 8, 29, 22, 21); // Sep 29 2026, 10:21pm

	it("buckets by calendar day, not elapsed hours", () => {
		expect(formatThreadTimeBucket(new Date(2026, 8, 29, 8), now)).toBe("Today");
		expect(formatThreadTimeBucket(new Date(2026, 8, 29, 23, 30), now)).toBe("Today");
		expect(formatThreadTimeBucket(new Date(2026, 8, 28, 23, 59), now)).toBe("Yesterday");
	});

	it("walks out through week, month, and older", () => {
		expect(formatThreadTimeBucket(new Date(2026, 8, 27), now)).toBe("Last week");
		expect(formatThreadTimeBucket(new Date(2026, 8, 22), now)).toBe("Last week");
		expect(formatThreadTimeBucket(new Date(2026, 8, 21), now)).toBe("Last month");
		expect(formatThreadTimeBucket(new Date(2026, 7, 30), now)).toBe("Last month");
		expect(formatThreadTimeBucket(new Date(2026, 7, 29), now)).toBe("Older");
	});
});
