/**
 * Post-plan branch consolidation (Plan 24, E3).
 *
 * After the Team Leader produces assignments, this deterministic repair pass
 * merges branches that share modules (connected-component grouping) and then
 * squashes the remaining branch count down to MAX_BRANCHES if necessary.
 *
 * The goal is to reduce the fixed per-branch overhead (scaffold, gate, review,
 * merge) without losing any assignments or stories.
 */
import { getLogger } from '../utils/logger';
import { sanitizeAssignmentStoryIds } from './assignment-policy';
import type { Assignment, UserStory } from '../agents/_shared/base-schemas';

const log = getLogger('[BranchConsolidation]', 226);

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Collect distinct branch names from assignments. */
function distinctBranches(assignments: Assignment[]): string[] {
    return [...new Set(assignments.map(a => a.branchName ?? a.id))];
}

/** Group assignments by their branch name. */
function groupByBranch(assignments: Assignment[]): Map<string, Assignment[]> {
    const groups = new Map<string, Assignment[]>();
    for (const a of assignments) {
        const branch = a.branchName ?? a.id;
        const list = groups.get(branch) ?? [];
        list.push(a);
        groups.set(branch, list);
    }
    return groups;
}

/** Collect all moduleIds from a list of assignments. */
function moduleSet(assignments: Assignment[]): Set<string> {
    const modules = new Set<string>();
    for (const a of assignments) {
        for (const m of a.moduleIds ?? []) modules.add(m);
    }
    return modules;
}

// ─── Union-Find for connected components ────────────────────────────────────

class UnionFind {
    private parent: Map<string, string> = new Map();
    private rank: Map<string, number> = new Map();

    find(x: string): string {
        if (!this.parent.has(x)) {
            this.parent.set(x, x);
            this.rank.set(x, 0);
        }
        let root = x;
        while (this.parent.get(root) !== root) {
            root = this.parent.get(root)!;
        }
        // Path compression
        let curr = x;
        while (curr !== root) {
            const next = this.parent.get(curr)!;
            this.parent.set(curr, root);
            curr = next;
        }
        return root;
    }

    union(a: string, b: string): void {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra === rb) return;
        const rankA = this.rank.get(ra) ?? 0;
        const rankB = this.rank.get(rb) ?? 0;
        if (rankA < rankB) {
            this.parent.set(ra, rb);
        } else if (rankA > rankB) {
            this.parent.set(rb, ra);
        } else {
            this.parent.set(rb, ra);
            this.rank.set(ra, rankA + 1);
        }
    }

    /** Return groups of items that share the same root. */
    components(items: string[]): Map<string, string[]> {
        const groups = new Map<string, string[]>();
        for (const item of items) {
            const root = this.find(item);
            const list = groups.get(root) ?? [];
            list.push(item);
            groups.set(root, list);
        }
        return groups;
    }
}

// ─── Core consolidation ─────────────────────────────────────────────────────

/**
 * Merge branches that share modules into connected components, then squash
 * the remaining count down to `maxBranches` if necessary.
 *
 * Returns the updated assignments and a log of what changed.
 */
export function consolidateBranches(
    assignments: Assignment[],
    maxBranches: number,
    userStories: UserStory[],
): { assignments: Assignment[]; consolidationLog: string[] } {
    const consolidationLog: string[] = [];

    if (assignments.length === 0) {
        return { assignments, consolidationLog };
    }

    const branchGroupsBefore = groupByBranch(assignments);
    const branchesBefore = [...branchGroupsBefore.keys()];
    const branchCountBefore = branchesBefore.length;

    if (branchCountBefore <= maxBranches) {
        // Check for module overlaps even if under the limit
        const collisions = countCollisions(branchGroupsBefore);
        if (collisions === 0) {
            consolidationLog.push(
                `No consolidation needed: ${branchCountBefore} branch(es) <= ${maxBranches} limit, 0 module collisions`,
            );
            return { assignments, consolidationLog };
        }
    }

    // Step 1: Build module-ownership overlap graph using union-find
    const uf = new UnionFind();
    const branchModules = new Map<string, Set<string>>();
    for (const [branch, branchAssignments] of branchGroupsBefore) {
        branchModules.set(branch, moduleSet(branchAssignments));
    }

    // Module -> which branches own it
    const moduleOwners = new Map<string, string[]>();
    for (const [branch, modules] of branchModules) {
        for (const mod of modules) {
            const owners = moduleOwners.get(mod) ?? [];
            owners.push(branch);
            moduleOwners.set(mod, owners);
        }
    }

    // Step 2: Find connected components via shared modules
    let collisionCount = 0;
    for (const [mod, owners] of moduleOwners) {
        if (owners.length > 1) {
            collisionCount++;
            for (let i = 1; i < owners.length; i++) {
                uf.union(owners[0], owners[i]);
            }
        }
    }

    // Build connected components
    const components = uf.components(branchesBefore);
    let result = mergeComponents(assignments, components, branchGroupsBefore);
    consolidationLog.push(
        `Module-overlap pass: ${branchCountBefore} branches -> ${distinctBranches(result).length} branches (${collisionCount} module collision(s) resolved)`,
    );

    // Step 3: If still over maxBranches, merge smallest branches
    let currentBranches = groupByBranch(result);
    if (currentBranches.size > maxBranches) {
        result = squashSmallest(result, maxBranches, consolidationLog);
    }

    // Step 4: Re-run sanitizeAssignmentStoryIds
    const sanitized = sanitizeAssignmentStoryIds(result, userStories, []);
    if (sanitized.dropped.length > 0) {
        log.warn(`Branch consolidation: dropped ${sanitized.dropped.length} unresolvable story id(s): ${sanitized.dropped.join(', ')}`);
    }
    result = sanitized.assignments;

    // Step 5: Log before/after table
    const branchGroupsAfter = groupByBranch(result);
    const branchCountAfter = branchGroupsAfter.size;
    const collisionsAfter = countCollisions(branchGroupsAfter);

    consolidationLog.push(
        `Consolidation summary: ${branchCountBefore} branches -> ${branchCountAfter} branches, ` +
        `${collisionCount} collisions -> ${collisionsAfter} collisions`,
    );

    for (const line of consolidationLog) {
        log.info(line);
    }

    return { assignments: result, consolidationLog };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Merge assignments within each connected component, picking the branch with
 * the most assignments as the surviving branch.
 */
function mergeComponents(
    assignments: Assignment[],
    components: Map<string, string[]>,
    branchGroups: Map<string, Assignment[]>,
): Assignment[] {
    // Build a map: old branch -> new branch (the surviving branch in each component)
    const branchRemap = new Map<string, string>();

    for (const [, componentBranches] of components) {
        if (componentBranches.length <= 1) continue;

        // Pick the branch with the most assignments as the survivor
        let survivor = componentBranches[0];
        let maxCount = (branchGroups.get(survivor) ?? []).length;
        for (let i = 1; i < componentBranches.length; i++) {
            const count = (branchGroups.get(componentBranches[i]) ?? []).length;
            if (count > maxCount) {
                maxCount = count;
                survivor = componentBranches[i];
            }
        }

        for (const branch of componentBranches) {
            if (branch !== survivor) {
                branchRemap.set(branch, survivor);
            }
        }
    }

    if (branchRemap.size === 0) return assignments;

    // Remap assignments
    return assignments.map(a => {
        const oldBranch = a.branchName ?? a.id;
        const newBranch = branchRemap.get(oldBranch);
        if (!newBranch) return a;
        return { ...a, branchName: newBranch };
    });
}

/**
 * Merge the smallest branches into the nearest overlapping branch (or the
 * smallest other branch if no overlap exists) until we're at or under maxBranches.
 */
function squashSmallest(
    assignments: Assignment[],
    maxBranches: number,
    consolidationLog: string[],
): Assignment[] {
    let groups = groupByBranch(assignments);

    while (groups.size > maxBranches) {
        // Find the smallest branch (fewest assignments)
        let smallestBranch = '';
        let smallestSize = Infinity;
        for (const [branch, branchAssignments] of groups) {
            if (branchAssignments.length < smallestSize) {
                smallestSize = branchAssignments.length;
                smallestBranch = branch;
            }
        }

        // Find the best merge target: prefer a branch with overlapping modules
        const smallModules = moduleSet(groups.get(smallestBranch) ?? []);
        let bestTarget = '';
        let bestOverlap = 0;
        let bestTargetSize = Infinity;

        for (const [branch, branchAssignments] of groups) {
            if (branch === smallestBranch) continue;
            const targetModules = moduleSet(branchAssignments);
            const overlap = [...smallModules].filter(m => targetModules.has(m)).length;
            if (overlap > bestOverlap || (overlap === bestOverlap && branchAssignments.length < bestTargetSize)) {
                bestOverlap = overlap;
                bestTarget = branch;
                bestTargetSize = branchAssignments.length;
            }
        }

        // If no overlap, pick the smallest other branch
        if (!bestTarget) {
            for (const [branch, branchAssignments] of groups) {
                if (branch === smallestBranch) continue;
                if (branchAssignments.length < bestTargetSize) {
                    bestTargetSize = branchAssignments.length;
                    bestTarget = branch;
                }
            }
        }

        if (!bestTarget) break; // Shouldn't happen with >1 branch

        consolidationLog.push(
            `Squash: merging branch "${smallestBranch}" (${smallestSize} assignments) into "${bestTarget}" (${bestTargetSize} assignments)` +
            (bestOverlap > 0 ? ` (${bestOverlap} shared module(s))` : ' (no overlap — smallest target)'),
        );

        // Remap all assignments from the smallest branch to the target
        assignments = assignments.map(a => {
            const branch = a.branchName ?? a.id;
            if (branch === smallestBranch) {
                return { ...a, branchName: bestTarget };
            }
            return a;
        });

        groups = groupByBranch(assignments);
    }

    return assignments;
}

/** Count the number of module-level collisions across branches. */
function countCollisions(branchGroups: Map<string, Assignment[]>): number {
    const moduleOwners = new Map<string, string[]>();
    for (const [branch, branchAssignments] of branchGroups) {
        for (const a of branchAssignments) {
            for (const m of a.moduleIds ?? []) {
                const owners = moduleOwners.get(m) ?? [];
                owners.push(branch);
                moduleOwners.set(m, owners);
            }
        }
    }
    let collisions = 0;
    for (const [, owners] of moduleOwners) {
        if (new Set(owners).size > 1) collisions++;
    }
    return collisions;
}
