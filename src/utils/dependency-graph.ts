/**
 * Dependency-graph helpers (Plan 30-01) — deterministic reachability and cycle
 * breaking over string-keyed graphs where an edge `a → b` means "a waits for b".
 *
 * Used by the dispatch planner at two levels: assignments and branches.
 */
import { transitiveReachable } from './source-graph';

/** Adjacency sets: node → the nodes it waits for. */
export type Graph = Map<string, Set<string>>;

/** A removed edge plus the strongly connected component it was removed from. */
export interface RemovedEdge {
    from: string;
    to: string;
    cycle: string[];
}

/** Every node `start` (transitively) waits for — `start` itself only when it lies on a cycle. */
export function reachableFrom(graph: Graph, start: string): Set<string> {
    return transitiveReachable(graph, [...(graph.get(start) ?? [])]);
}

/** True when adding the edge `from → to` (from waits for to) would close a cycle. */
export function wouldCreateCycle(graph: Graph, from: string, to: string): boolean {
    return from === to || reachableFrom(graph, to).has(from);
}

/** Tarjan's strongly connected components, visiting `nodes` and their edges in order. */
function stronglyConnected(nodes: string[], graph: Graph): string[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const components: string[][] = [];
    const visit = (v: string): void => {
        index.set(v, index.size);
        low.set(v, index.get(v)!);
        stack.push(v);
        onStack.add(v);
        for (const w of graph.get(v) ?? []) {
            if (!index.has(w)) {
                visit(w);
                low.set(v, Math.min(low.get(v)!, low.get(w)!));
            } else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v)!, index.get(w)!));
            }
        }
        if (low.get(v) !== index.get(v)) return;
        const component: string[] = [];
        let w: string;
        do {
            w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
        } while (w !== v);
        components.push(component);
    };
    for (const v of nodes) if (!index.has(v)) visit(v);
    return components;
}

/**
 * Remove edges from `graph` (in place) until it is acyclic, deterministically.
 *
 * Every cycle contains at least one "forward" edge — a node waiting for a node
 * listed after it in `nodes` (or for itself). In each cyclic component the
 * forward edge whose dependent is listed earliest is removed (ties: the latest
 * dependency), then components are recomputed. Planners list work roughly in
 * dependency order, so this keeps the listed order wherever a plan contradicts itself.
 */
export function breakCycles(nodes: string[], graph: Graph): RemovedEdge[] {
    const position = new Map(nodes.map((n, i) => [n, i]));
    const removed: RemovedEdge[] = [];
    for (;;) {
        const cyclic = stronglyConnected(nodes, graph)
            .filter(c => c.length > 1 || graph.get(c[0])?.has(c[0]))
            .map(c => c.sort((x, y) => position.get(x)! - position.get(y)!));
        if (cyclic.length === 0) return removed;
        for (const cycle of cyclic) {
            const members = new Set(cycle);
            let pick: { from: string; to: string } | null = null;
            for (const from of cycle) {
                for (const to of graph.get(from) ?? []) {
                    if (!members.has(to) || position.get(to)! < position.get(from)!) continue;
                    if (!pick || position.get(from)! < position.get(pick.from)!
                        || (from === pick.from && position.get(to)! > position.get(pick.to)!)) {
                        pick = { from, to };
                    }
                }
            }
            graph.get(pick!.from)!.delete(pick!.to);
            removed.push({ ...pick!, cycle });
        }
    }
}
