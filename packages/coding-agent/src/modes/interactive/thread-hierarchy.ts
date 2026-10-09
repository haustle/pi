/**
 * Order saved threads as a handoff forest: each thread's handoff children are emitted directly
 * after it, depth-first. Roots and siblings keep the incoming (newest-first) order, and a whole
 * subtree carries its root's time bucket so a child never lands in a different group than its
 * parent. Cycles and parents outside the loaded set are treated as roots.
 */

export interface ThreadHierarchyNode<T> {
	session: T;
	/** 0 for a root, 1 for a direct handoff child, and so on. */
	depth: number;
	parent?: T;
	group: string;
}

export function orderThreadHierarchy<T extends { path: string; parentSessionPath?: string }>(
	sessions: readonly T[],
	groupOf: (session: T) => string,
	limit: number,
): ThreadHierarchyNode<T>[] {
	const byPath = new Map(sessions.map((session) => [session.path, session]));

	const depthCache = new Map<string, number>();
	const depthOf = (session: T): number => {
		const cached = depthCache.get(session.path);
		if (cached !== undefined) return cached;
		const seen = new Set<string>([session.path]);
		let depth = 0;
		let parentPath = session.parentSessionPath;
		while (parentPath && byPath.has(parentPath)) {
			if (seen.has(parentPath)) {
				depth = 0;
				break;
			}
			seen.add(parentPath);
			depth++;
			parentPath = byPath.get(parentPath)?.parentSessionPath;
		}
		depthCache.set(session.path, depth);
		return depth;
	};

	const children = new Map<string, T[]>();
	for (const session of sessions) {
		const parentPath = session.parentSessionPath;
		if (!parentPath || !byPath.has(parentPath)) continue;
		const list = children.get(parentPath) ?? [];
		list.push(session);
		children.set(parentPath, list);
	}

	const out: ThreadHierarchyNode<T>[] = [];
	const visited = new Set<string>();
	const emit = (session: T, group: string): void => {
		if (visited.has(session.path) || out.length >= limit) return;
		visited.add(session.path);
		const parentPath = session.parentSessionPath;
		out.push({
			session,
			depth: depthOf(session),
			parent: parentPath ? byPath.get(parentPath) : undefined,
			group,
		});
		for (const child of children.get(session.path) ?? []) emit(child, group);
	};

	for (const session of sessions) {
		if (depthOf(session) === 0) emit(session, groupOf(session));
	}
	// Orphans left by a parent that resolved into a cycle.
	for (const session of sessions) {
		if (!visited.has(session.path)) emit(session, groupOf(session));
	}
	return out;
}
