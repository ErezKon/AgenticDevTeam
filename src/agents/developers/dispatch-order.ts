/**
 * Dispatch ordering (pure): assignment-level topological sort and the Plan 30-O
 * branch-level layering used by the dispatcher. Extracted from dispatcher.ts.
 */
import { getLogger } from '../../utils/logger';
import type { Assignment } from '../_shared/base-schemas';

const log = getLogger('[Dispatcher]', 226);

/**
 * Topological sort on assignments by dependsOn.
 * Returns assignments in execution order (groups of independent assignments).
 *
 * `preSatisfied` seeds the completed set so dependencies on already-merged
 * work are treated as resolved rather than triggering the "cyclic" fallback.
 */
export function topoSort(
    assignments: Assignment[],
    preSatisfied: Set<string> = new Set(),
): Assignment[][] {
    const map = new Map<string, Assignment>();
    for (const a of assignments) map.set(a.id, a);

    // Detect and warn about dangling dependsOn ids (P10): treat them as pre-satisfied
    // rather than collapsing all layers into one parallel batch.
    const allIds = new Set([...map.keys(), ...preSatisfied]);
    for (const a of assignments) {
        for (const dep of a.dependsOn) {
            if (!allIds.has(dep)) {
                log.warn(`Assignment ${a.id} dependsOn non-existent id "${dep}" — treating as pre-satisfied`);
                preSatisfied.add(dep);
            }
        }
    }

    const completed = new Set<string>(preSatisfied);
    const layers: Assignment[][] = [];

    while (assignments.filter(a => !completed.has(a.id)).length > 0) {
        const ready = assignments.filter(
            a => !completed.has(a.id) &&
                a.dependsOn.every(dep => completed.has(dep))
        );
        if (ready.length === 0) {
            // Plan 30-O: break the cycle at ONE node and keep layering. Pushing every
            // remaining node into one batch threw away the ordering of the whole plan.
            // Plan 30-U: release the node the most remaining nodes depend on (the
            // foundation), then fewest unmet dependencies, then plan order. "Fewest unmet"
            // alone released a consumer of the maze branch before the maze itself
            // (pacman-live-analysis-9).
            const remaining = assignments.filter(a => !completed.has(a.id));
            const unmet = (a: Assignment) => a.dependsOn.filter(dep => !completed.has(dep)).length;
            const dependents = (a: Assignment) => remaining.filter(x => x.dependsOn.includes(a.id)).length;
            const breaker = remaining.reduce((best, a) => {
                const byDependents = dependents(a) - dependents(best);
                if (byDependents !== 0) return byDependents > 0 ? a : best;
                return unmet(a) < unmet(best) ? a : best;
            });
            log.warn(`topoSort: ${remaining.length} item(s) have cyclic dependencies — releasing ${breaker.id} (${dependents(breaker)} dependents, ${unmet(breaker)} unmet) to break the cycle`);
            layers.push([breaker]);
            completed.add(breaker.id);
            continue;
        }
        layers.push(ready);
        for (const a of ready) completed.add(a.id);
    }
    return layers;
}

/**
 * Plan 30-O: dispatch layers at BRANCH granularity. A branch runs with all of its
 * assignments, so it may only start once every branch its assignments depend on has
 * been processed. Assignment-level layers dispatched a branch as soon as its EARLIEST
 * assignment was ready — e.g. a UI-integration branch whose last assignment depends on
 * 13 others ran right after the scaffold. Each returned layer holds the assignments of
 * the branches that become ready together; dependencies on completed work are ignored.
 *
 * Plan 30-U: `isRoot` branches (the scaffold) never wait for anything — every other
 * branch depends on them, so any edge out of a root can only close a cycle.
 */
export function orderBranchLayers(
    assignments: Assignment[],
    branchOf: (a: Assignment) => string,
    preSatisfied: Set<string> = new Set(),
    isRoot: (branch: string) => boolean = () => false,
): Assignment[][] {
    const groups = new Map<string, Assignment[]>();
    for (const a of assignments) {
        const branch = branchOf(a);
        groups.set(branch, [...(groups.get(branch) ?? []), a]);
    }
    const branchOfId = new Map(assignments.map(a => [a.id, branchOf(a)]));
    const branchNodes = [...groups].map(([branch, members]) => ({
        id: branch,
        dependsOn: isRoot(branch) ? [] : [...new Set(members.flatMap(a => a.dependsOn)
            .filter(dep => !preSatisfied.has(dep))
            .map(dep => branchOfId.get(dep))
            .filter((b): b is string => b !== undefined && b !== branch))],
    }) as unknown as Assignment);
    return topoSort(branchNodes).map(layer => layer.flatMap(node => groups.get(node.id) ?? []));
}
