import { describe, expect, it } from "vitest";
import { FORK_DEFAULT_PACKAGES } from "../src/fork-default-packages.ts";

/** `npm:name@1.2.3` — a bare name parses as a local path and is quietly dropped. */
const EXACT_NPM_SPEC = /^npm:(?:@[^/@]+\/)?[^@]+@\d+\.\d+\.\d+$/;

describe("fork default packages", () => {
	it("uses exact, npm-prefixed specs", () => {
		for (const spec of FORK_DEFAULT_PACKAGES) {
			expect(spec, `${spec} must look like npm:name@1.2.3`).toMatch(EXACT_NPM_SPEC);
		}
	});

	it("lists each package once", () => {
		const names = FORK_DEFAULT_PACKAGES.map((spec) => spec.slice(0, spec.lastIndexOf("@")));
		expect(new Set(names).size).toBe(names.length);
	});
});
