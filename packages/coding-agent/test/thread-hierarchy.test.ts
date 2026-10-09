import { describe, expect, it } from "vitest";
import { orderThreadHierarchy } from "../src/modes/interactive/thread-hierarchy.ts";

interface Node {
	path: string;
	parentSessionPath?: string;
	group: string;
}

const fixture = (path: string, group: string, parentSessionPath?: string): Node => ({
	path,
	group,
	parentSessionPath,
});

const order = (nodes: Node[], limit = 100): { path: string; depth: number; group: string }[] =>
	orderThreadHierarchy(nodes, (node) => node.group, limit).map(({ session, depth, group }) => ({
		path: session.path,
		depth,
		group,
	}));

describe("orderThreadHierarchy", () => {
	it("nests children and grandchildren under their parent", () => {
		const grandchild = fixture("c", "today", "b");
		const child = fixture("b", "today", "a");
		const root = fixture("a", "today");
		expect(order([grandchild, child, root])).toEqual([
			{ path: "a", depth: 0, group: "today" },
			{ path: "b", depth: 1, group: "today" },
			{ path: "c", depth: 2, group: "today" },
		]);
	});

	it("keeps a child in its parent's time bucket even when it is newer", () => {
		const child = fixture("child", "today", "parent");
		const parent = fixture("parent", "yesterday");
		expect(order([child, parent])).toEqual([
			{ path: "parent", depth: 0, group: "yesterday" },
			{ path: "child", depth: 1, group: "yesterday" },
		]);
	});

	it("treats a thread whose parent is not loaded as a root", () => {
		expect(order([fixture("orphan", "today", "missing")])).toEqual([{ path: "orphan", depth: 0, group: "today" }]);
	});

	it("survives a parent cycle", () => {
		const a = fixture("a", "today", "b");
		const b = fixture("b", "today", "a");
		const result = order([a, b]);
		expect(result.map((node) => node.path).sort()).toEqual(["a", "b"]);
		expect(result.every((node) => node.depth === 0)).toBe(true);
	});

	it("keeps the incoming order among roots and siblings", () => {
		const root1 = fixture("r1", "today");
		const root2 = fixture("r2", "today");
		const child1 = fixture("c1", "today", "r1");
		const child2 = fixture("c2", "today", "r1");
		expect(order([root1, child1, root2, child2]).map((node) => node.path)).toEqual(["r1", "c1", "c2", "r2"]);
	});

	it("respects the limit across a subtree", () => {
		const nodes = [fixture("a", "today"), fixture("b", "today", "a"), fixture("c", "today", "b")];
		expect(order(nodes, 2).map((node) => node.path)).toEqual(["a", "b"]);
	});
});
