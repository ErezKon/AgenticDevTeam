/**
 * Dispatch planning — the pure half of the developer dispatcher (Plan 30-01).
 *
 * Turns the Team Leader's assignments into a branch DAG: which branch every
 * assignment runs on, what kind of branch it is, which branches must merge
 * before it may start, and the order the dispatcher runs them in.
 *
 * The claudeopus5 run got stuck because planning made four wrong calls:
 *  1. a `chore`-typed asset audit turned its feature branch into "the scaffold";
 *  2. story-id canonicalisation moved feature work and the FINAL INTEGRATION
 *     assignment onto the scaffold branch, overriding the Team Leader;
 *  3. the bootstrap barrier made every feature depend on that integration
 *     assignment, which itself depended on every feature — a 23-assignment
 *     cycle that topoSort "resolved" by dispatching everything in one batch;
 *  4. a branch started as soon as ANY of its assignments was ready, so it was
 *     built on `not implemented` stubs of branches that had not merged yet.
 *
 * Rules now:
 *  - only the branch name `<slug>/chore/scaffold` makes work scaffold work;
 *  - an explicit `branchName` always wins;
 *  - a barrier edge is never injected when it would close a cycle, and app
 *    wiring that depends on feature work is a `finalizer` that simply runs last;
 *  - any cycle the Team Leader wrote is broken deterministically and reported;
 *  - a branch starts only after every branch it depends on has finished.
 *
 * Nothing here logs, emits or touches git: the dispatcher records the plan, and
 * `validateAssignmentPlan` runs the same analysis right after the Team Leader.
 */
import { featureBranch } from '../../utils/branch-naming';
import { assertValidRef } from '../../utils/git-exec';
import { breakCycles, reachableFrom, wouldCreateCycle } from '../../utils/dependency-graph';
import type { Graph } from '../../utils/dependency-graph';
import { getDevAgent } from './registry';
import type { DispatchHaltPolicy } from '../../config';
import type { DispatchPlanRecord } from '../../utils/run-ledger';
import type { Assignment } from '../_shared/base-schemas';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * How an assignment (and the branch carrying it) is scheduled.
 * - `scaffold`:  on the scaffold branch; everything else waits for it.
 * - `bootstrap`: entry-point / wiring work that needs only the scaffold; feature work waits for it.
 * - `finalizer`: wiring work that depends on feature work; nothing waits for it and it runs last.
 * - `feature`:   everything else.
 */
export type AssignmentKind = 'scaffold' | 'bootstrap' | 'feature' | 'finalizer';

/** A dependency edge: `from` waits for `to`. */
export interface PlanEdge {
    from: string;
    to: string;
}

/** An edge the planner deliberately did not add (barrier) or keep (scaffold → feature). */
export interface SkippedEdge extends PlanEdge {
    reason: 'scaffold-depends-on-feature' | 'would-create-cycle';
}

/** An edge removed to break a dependency cycle. */
export interface BrokenEdge extends PlanEdge {
    level: 'assignment' | 'branch';
    /** Members of the strongly connected component the edge was removed from. */
    cycle: string[];
    /** Branch level only: the assignment edges that made `from` wait for `to`. */
    via?: PlanEdge[];
}

export interface PlannedBranch {
    name: string;
    kind: AssignmentKind;
    /** Why the branch got its kind, e.g. "finalizer: ASSIGN-027 … depends on 23 feature assignment(s)". */
    reason: string;
    /** In intra-branch dependency order; `branchName` resolved, `dependsOn` as the planner will honour it. */
    assignments: Assignment[];
    /** Branches that must finish before this one starts, in dispatch order. */
    dependsOnBranches: string[];
    taskType: Assignment['taskType'];
    reviewerAgentIds: string[];
}

export interface DispatchPlan {
    branches: Map<string, PlannedBranch>;
    /** A branch depends only on branches in earlier layers. */
    layers: string[][];
    /** `layers.flat()` — the order a sequential dispatch runs branches in. */
    branchOrder: string[];
    /** Same-layer branches that own a common module, so must not run concurrently. */
    overlaps: Map<string, Set<string>>;
    assignmentKinds: Map<string, AssignmentKind>;
    /** Stories whose assignments the Team Leader spread over several branches. */
    storySplits: Array<{ storyId: string; branches: string[] }>;
    warnings: string[];
    skippedEdges: SkippedEdge[];
    brokenEdges: BrokenEdge[];
}

export interface DispatchPlanOptions {
    projectSlug: string;
    /** Assignment ids merged in earlier rounds — dependencies on them are satisfied. */
    preSatisfied?: Iterable<string>;
}

export interface TopoSortResult {
    /** Layers of mutually independent assignments; broken edges are removed from `dependsOn`. */
    layers: Assignment[][];
    brokenEdges: BrokenEdge[];
    /** Dangling `dependsOn` ids (treated as satisfied). */
    warnings: string[];
}

// ─── Scaffold classification ────────────────────────────────────────────────

/**
 * Matches a scaffold branch name with or without a project prefix.
 * Plan 22 F1: the Team Leader emits `chore/scaffold`; the dispatcher adds `<slug>/`.
 */
export const SCAFFOLD_BRANCH_RE = /(^|\/)chore\/scaffold$/i;

/** True when a dispatch branch is the scaffold branch. Only the name decides (Plan 30-01). */
export function isScaffoldBranch(branch: string): boolean {
    return SCAFFOLD_BRANCH_RE.test(branch);
}

/**
 * True when an assignment is scaffold work — by branch name only. `taskType:
 * 'chore'` describes the kind of work: in the claudeopus5 run a `chore`-typed
 * asset audit made a seven-assignment feature branch "the scaffold".
 */
export function isScaffoldAssignment(a: Assignment): boolean {
    return isScaffoldBranch(a.branchName ?? '');
}

// ─── Branch naming ──────────────────────────────────────────────────────────

/**
 * Canonical dispatch branch for an assignment.
 *
 * An explicit `branchName` wins: it is prefixed with the project slug,
 * sanitised and ref-checked (Plan 25-02, A4). Without one, the assignment
 * follows the first non-scaffold branch already recorded for its story, else
 * a derived feature branch. `storyBranches` only ever records non-scaffold
 * branches, so work is never moved onto the scaffold or off it.
 *
 * The previous rule sent every assignment of a story to the first branch seen
 * for that story, which put feature work and the FINAL INTEGRATION assignment
 * onto the scaffold branch in the claudeopus5 run.
 */
export function canonicalBranchName(
    a: Assignment,
    projectSlug: string,
    storyBranches: Map<string, string>,
): string {
    const storyKey = a.storyId || a.id;
    const explicit = a.branchName?.trim();
    if (!explicit) {
        const existing = storyBranches.get(storyKey);
        if (existing) return existing;
    }
    let branch = explicit || featureBranch(projectSlug, storyKey, a.description);
    if (projectSlug && !branch.startsWith(`${projectSlug}/`)) branch = `${projectSlug}/${branch}`;
    branch = branch.replace(/[^a-zA-Z0-9/_.-]/g, '-').replace(/-{2,}/g, '-');
    assertValidRef(branch);
    if (!isScaffoldBranch(branch) && !storyBranches.has(storyKey)) storyBranches.set(storyKey, branch);
    return branch;
}

/**
 * Resolve every assignment's branch. Explicit names go first so they seed their
 * story's branch for the assignments that have none. An explicit name that is
 * not a valid git ref even after sanitising falls back to the story's branch
 * instead of failing the whole dispatch.
 */
function resolveBranches(assignments: Assignment[], projectSlug: string, warnings: string[]): Map<string, string> {
    const storyBranches = new Map<string, string>();
    const branchOf = new Map<string, string>();
    for (const a of assignments) {
        if (!a.branchName?.trim()) continue;
        try {
            branchOf.set(a.id, canonicalBranchName(a, projectSlug, storyBranches));
        } catch (err: any) {
            warnings.push(`Assignment ${a.id}: ignoring branchName "${a.branchName}" (${err.message}) — using its story's branch`);
        }
    }
    for (const a of assignments) {
        if (!branchOf.has(a.id)) branchOf.set(a.id, canonicalBranchName({ ...a, branchName: undefined }, projectSlug, storyBranches));
    }
    return branchOf;
}

const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

// ─── Topological sort ───────────────────────────────────────────────────────

/**
 * Topological sort on assignments by `dependsOn`, in layers of mutually
 * independent assignments. `preSatisfied` ids (merged in an earlier round)
 * count as done; any other unknown id is treated the same way, with a warning.
 *
 * Plan 30-01: a cycle no longer collapses everything into "one parallel batch"
 * — it is broken deterministically and each removed edge is returned.
 */
export function topoSort(
    assignments: Assignment[],
    preSatisfied: ReadonlySet<string> = new Set(),
): TopoSortResult {
    const warnings: string[] = [];
    const ids = new Set(assignments.map(a => a.id));
    const graph: Graph = new Map();
    for (const a of assignments) {
        const deps = graph.get(a.id) ?? new Set<string>();
        for (const dep of a.dependsOn ?? []) {
            if (ids.has(dep)) deps.add(dep);
            else if (!preSatisfied.has(dep)) warnings.push(`Assignment ${a.id} dependsOn non-existent id "${dep}" — treating as pre-satisfied`);
        }
        graph.set(a.id, deps);
    }

    const brokenEdges: BrokenEdge[] = breakCycles([...ids], graph).map(e => ({ ...e, level: 'assignment' as const }));
    const removed = new Set(brokenEdges.map(e => edgeKey(e.from, e.to)));
    let remaining: Assignment[] = removed.size === 0 ? assignments : assignments.map(a => {
        const dependsOn = (a.dependsOn ?? []).filter(dep => !removed.has(edgeKey(a.id, dep)));
        return dependsOn.length === (a.dependsOn ?? []).length ? a : { ...a, dependsOn };
    });

    const layers: Assignment[][] = [];
    const done = new Set<string>();
    while (remaining.length > 0) {
        const ready = remaining.filter(a => [...graph.get(a.id)!].every(dep => done.has(dep)));
        if (ready.length === 0) throw new Error('topoSort: a dependency cycle survived cycle breaking');
        layers.push(ready);
        for (const a of ready) done.add(a.id);
        remaining = remaining.filter(a => !done.has(a.id));
    }
    return { layers, brokenEdges, warnings };
}

// ─── Bootstrap / finalizer detection (Plan 24 E4, Plan 30-01) ──────────────

/** moduleIds that mark an entry-point / app-root module. */
const ENTRY_MODULE_PATTERNS = [/^MOD-MAIN$/i, /^MOD-APP$/i, /^MOD-ROOT$/i, /^MOD-ENTRY$/i];

/** Description keywords that mark bootstrap / wiring work. */
const BOOTSTRAP_TEXT_PATTERNS = [
    /\bbootstrap\b/i, /\bwiring\b/i, /\bentry\s*point\b/i,
    /\bapp\s*initializ/i, /\bcomposition\s*root\b/i,
];

/** Why an assignment looks like bootstrap / wiring work, or null. */
function bootstrapSignal(a: Assignment): string | null {
    const entryModule = (a.moduleIds ?? []).find(m => ENTRY_MODULE_PATTERNS.some(re => re.test(m)));
    if (entryModule) return `owns entry module ${entryModule}`;
    for (const re of BOOTSTRAP_TEXT_PATTERNS) {
        const match = re.exec(a.description ?? '');
        if (match) return `mentions "${match[0]}"`;
    }
    return null;
}

// ─── Branch helpers ─────────────────────────────────────────────────────────

const KIND_RANK: Record<AssignmentKind, number> = { scaffold: 0, bootstrap: 1, feature: 2, finalizer: 3 };

/**
 * Kahn layering of the (acyclic) branch graph, ordered by kind then first
 * appearance. Finalizer branches are held back while anything else is ready,
 * so app-wiring work runs last.
 */
function layerBranches(names: string[], graph: Graph, kindOf: (branch: string) => AssignmentKind): string[][] {
    const position = new Map(names.map((n, i) => [n, i]));
    const layers: string[][] = [];
    const done = new Set<string>();
    let remaining = names;
    while (remaining.length > 0) {
        const ready = remaining.filter(b => [...graph.get(b)!].every(dep => done.has(dep)));
        const early = ready.filter(b => kindOf(b) !== 'finalizer');
        const layer = (early.length > 0 ? early : ready)
            .sort((x, y) => KIND_RANK[kindOf(x)] - KIND_RANK[kindOf(y)] || position.get(x)! - position.get(y)!);
        if (layer.length === 0) throw new Error('layerBranches: a branch cycle survived cycle breaking');
        layers.push(layer);
        for (const b of layer) done.add(b);
        remaining = remaining.filter(b => !done.has(b));
    }
    return layers;
}

/**
 * Same-layer branches with overlapping moduleIds (Sub-Plan 06 §5b). Branches in
 * different layers already run one after the other.
 */
function findOverlappingBranches(
    layers: string[][],
    assignmentsOf: (branch: string) => Assignment[],
    warnings: string[],
): Map<string, Set<string>> {
    const overlaps = new Map<string, Set<string>>();
    const link = (x: string, y: string) => {
        if (!overlaps.has(x)) overlaps.set(x, new Set());
        overlaps.get(x)!.add(y);
    };
    for (const layer of layers) {
        const modules = layer.map(b => new Set(assignmentsOf(b).flatMap(a => a.moduleIds ?? [])));
        for (let i = 0; i < layer.length; i++) {
            for (let j = i + 1; j < layer.length; j++) {
                const shared = [...modules[i]].filter(m => modules[j].has(m));
                if (shared.length === 0) continue;
                warnings.push(`Branches ${layer[i]} and ${layer[j]} both own ${shared.join(', ')} — they will not run concurrently`);
                link(layer[i], layer[j]);
                link(layer[j], layer[i]);
            }
        }
    }
    return overlaps;
}

/** Primary task type of a branch. Priority: bug > fix > refactor > feature > chore. */
function primaryTaskType(assignments: Assignment[]): Assignment['taskType'] {
    const types = new Set(assignments.map(a => a.taskType ?? 'feature'));
    return (['bug', 'fix', 'refactor', 'feature', 'chore'] as const).find(t => types.has(t)) ?? 'feature';
}

/**
 * Reviewer ids from all assignments on a branch, de-duplicated and capped at
 * the 2 highest-ranked so review cost does not grow with branch size.
 */
function collectReviewers(assignments: Assignment[]): string[] {
    const all = [...new Set(assignments.flatMap(a => a.reviewerAgentIds ?? []))];
    if (all.length <= 2) return all;
    const RANK_ORDER: Record<string, number> = { principal: 2, senior: 1, junior: 0 };
    return all
        .sort((x, y) =>
            (RANK_ORDER[getDevAgent(y)?.rank ?? 'junior'] ?? 0) -
            (RANK_ORDER[getDevAgent(x)?.rank ?? 'junior'] ?? 0))
        .slice(0, 2);
}

// ─── Plan builder ───────────────────────────────────────────────────────────

/**
 * Build the dispatch plan for one development round.
 *
 * 1. Resolve branches (explicit names win).
 * 2. Scaffold work drops its dependencies on feature work.
 * 3. Classify: scaffold by branch name; bootstrap-looking work is `bootstrap`
 *    when it needs nothing but the scaffold, else a `finalizer`.
 * 4. Barriers: non-scaffold work waits for the scaffold, feature work waits for
 *    bootstrap work — unless the edge would close a cycle.
 * 5. Order assignments, breaking any remaining (Team-Leader-authored) cycle.
 * 6. Derive the branch graph, break branch-level cycles, layer the branches.
 */
export function buildDispatchPlan(input: Assignment[], opts: DispatchPlanOptions): DispatchPlan {
    const warnings: string[] = [];
    const skippedEdges: SkippedEdge[] = [];

    const seen = new Set<string>();
    const unique = input.filter(a => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
    });
    const branchOf = resolveBranches(unique, opts.projectSlug, warnings);
    const ids = new Set(unique.map(a => a.id));
    const onScaffold = (id: string): boolean => isScaffoldBranch(branchOf.get(id)!);

    // 1–2. Working copies carry the resolved branch; scaffold work never waits for feature work.
    const copies = unique.map(a => {
        const branchName = branchOf.get(a.id)!;
        const dependsOn = (a.dependsOn ?? []).filter(dep => {
            if (!onScaffold(a.id) || !ids.has(dep) || onScaffold(dep)) return true;
            skippedEdges.push({ from: a.id, to: dep, reason: 'scaffold-depends-on-feature' });
            warnings.push(`Scaffold assignment ${a.id} depends on feature assignment ${dep} — dependency dropped (the scaffold always runs first)`);
            return false;
        });
        return { ...a, branchName, dependsOn };
    });
    const byId = new Map(copies.map(a => [a.id, a]));
    const graph: Graph = new Map(copies.map(a => [a.id, new Set(a.dependsOn.filter(dep => ids.has(dep)))]));

    // 3. Classify.
    const assignmentKinds = new Map<string, AssignmentKind>();
    const kindReasons = new Map<string, string>();
    for (const a of copies) {
        if (isScaffoldAssignment(a)) {
            assignmentKinds.set(a.id, 'scaffold');
            continue;
        }
        const signal = bootstrapSignal(a);
        if (!signal) {
            assignmentKinds.set(a.id, 'feature');
            continue;
        }
        const featureDeps = [...reachableFrom(graph, a.id)].filter(id => !onScaffold(id));
        assignmentKinds.set(a.id, featureDeps.length === 0 ? 'bootstrap' : 'finalizer');
        kindReasons.set(a.id, featureDeps.length === 0
            ? `${a.id} ${signal}`
            : `${a.id} ${signal} but depends on ${featureDeps.length} feature assignment(s)`);
    }

    // 4. Barrier edges — never one that would close an assignment or branch cycle.
    const branchGraph: Graph = new Map(copies.map(a => [a.branchName, new Set<string>()]));
    for (const a of copies) {
        for (const dep of graph.get(a.id)!) {
            if (branchOf.get(dep) !== a.branchName) branchGraph.get(a.branchName)!.add(branchOf.get(dep)!);
        }
    }
    const addBarrier = (from: string, to: string): void => {
        if (graph.get(from)!.has(to)) return;
        const [fromBranch, toBranch] = [branchOf.get(from)!, branchOf.get(to)!];
        const closesCycle = fromBranch === toBranch
            ? wouldCreateCycle(graph, from, to)
            : wouldCreateCycle(branchGraph, fromBranch, toBranch);
        if (closesCycle) {
            skippedEdges.push({ from, to, reason: 'would-create-cycle' });
            return;
        }
        graph.get(from)!.add(to);
        if (fromBranch !== toBranch) branchGraph.get(fromBranch)!.add(toBranch);
        byId.get(from)!.dependsOn.push(to);
    };
    const idsOfKind = (kind: AssignmentKind) => copies.filter(a => assignmentKinds.get(a.id) === kind).map(a => a.id);
    const scaffoldIds = idsOfKind('scaffold');
    const bootstrapIds = idsOfKind('bootstrap');
    for (const a of copies) {
        const kind = assignmentKinds.get(a.id)!;
        if (kind === 'scaffold') continue;
        for (const s of scaffoldIds) addBarrier(a.id, s);
        if (kind === 'feature') for (const b of bootstrapIds) addBarrier(a.id, b);
    }

    // 5. Assignment order (breaks Team-Leader-authored cycles).
    const topo = topoSort(copies, new Set(opts.preSatisfied ?? []));
    warnings.push(...topo.warnings);
    const brokenEdges: BrokenEdge[] = [...topo.brokenEdges];
    const ordered = topo.layers.flat();

    // 6. Branch graph from the dependencies that survived; branch-level cycles broken.
    const names = [...new Set(copies.map(a => a.branchName))];
    const listOf = new Map(names.map(n => [n, ordered.filter(a => branchOf.get(a.id) === n)]));
    const branchDeps: Graph = new Map(names.map(n => [n, new Set<string>()]));
    const via = new Map<string, PlanEdge[]>();
    for (const a of ordered) {
        const from = branchOf.get(a.id)!;
        for (const dep of a.dependsOn) {
            const to = branchOf.get(dep);
            if (!to || to === from) continue;
            branchDeps.get(from)!.add(to);
            const key = edgeKey(from, to);
            via.set(key, [...(via.get(key) ?? []), { from: a.id, to: dep }]);
        }
    }
    for (const e of breakCycles(names, branchDeps)) {
        brokenEdges.push({ ...e, level: 'branch', via: via.get(edgeKey(e.from, e.to)) ?? [] });
    }

    const branchKinds = new Map(names.map(n => {
        const kinds = new Set(listOf.get(n)!.map(a => assignmentKinds.get(a.id)));
        const kind: AssignmentKind = isScaffoldBranch(n) ? 'scaffold'
            : kinds.has('finalizer') ? 'finalizer'
                : kinds.has('bootstrap') ? 'bootstrap' : 'feature';
        return [n, kind] as const;
    }));
    const layers = layerBranches(names, branchDeps, b => branchKinds.get(b)!);
    const branchOrder = layers.flat();
    const overlaps = findOverlappingBranches(layers, b => listOf.get(b)!, warnings);

    const storyBranchSets = new Map<string, Set<string>>();
    for (const a of copies) {
        if (!a.storyId) continue;
        if (!storyBranchSets.has(a.storyId)) storyBranchSets.set(a.storyId, new Set());
        storyBranchSets.get(a.storyId)!.add(a.branchName);
    }
    const storySplits = [...storyBranchSets]
        .filter(([, set]) => set.size > 1)
        .map(([storyId, set]) => ({ storyId, branches: [...set] }));
    for (const s of storySplits) warnings.push(`Story ${s.storyId} spans ${s.branches.length} branches: ${s.branches.join(', ')}`);

    const branches = new Map<string, PlannedBranch>();
    for (const name of branchOrder) {
        const list = listOf.get(name)!;
        const kind = branchKinds.get(name)!;
        const reason = kind === 'scaffold' ? 'scaffold: branch name is <slug>/chore/scaffold'
            : kind === 'feature' ? 'feature'
                : `${kind}: ${list.filter(a => assignmentKinds.get(a.id) === kind).map(a => kindReasons.get(a.id)).join('; ')}`;
        branches.set(name, {
            name, kind, reason,
            assignments: list,
            dependsOnBranches: branchOrder.filter(b => branchDeps.get(name)!.has(b)),
            taskType: primaryTaskType(list),
            reviewerAgentIds: collectReviewers(list),
        });
    }

    return { branches, layers, branchOrder, overlaps, assignmentKinds, storySplits, warnings, skippedEdges, brokenEdges };
}

// ─── Dispatch-time helpers ──────────────────────────────────────────────────

/**
 * Split one layer's branches into chains that must run one after the other
 * (they own a common module) and branches that may run in parallel.
 */
export function serialiseOverlaps(plan: DispatchPlan, branches: string[]): { chains: string[][]; parallel: string[] } {
    const chains: string[][] = [];
    const parallel: string[] = [];
    const placed = new Set<string>();
    for (const branch of branches) {
        if (placed.has(branch)) continue;
        const peers = [...(plan.overlaps.get(branch) ?? [])].filter(b => branches.includes(b) && !placed.has(b));
        const group = [branch, ...peers];
        for (const b of group) placed.add(b);
        if (peers.length === 0) parallel.push(branch);
        else chains.push(group);
    }
    return { chains, parallel };
}

/** Branches that (transitively) wait for `branch`, in dispatch order. */
function transitiveDependents(plan: DispatchPlan, branch: string): string[] {
    const dependents = new Set<string>();
    for (const b of plan.branchOrder) {
        if (plan.branches.get(b)!.dependsOnBranches.some(d => d === branch || dependents.has(d))) dependents.add(b);
    }
    return [...dependents];
}

/**
 * How the dispatcher reacts when `branch` finishes a round without merging.
 * - `strict` halts; `scaffold-only` halts only for the scaffold (Plan 27-B).
 * - `dependents` (default) skips just the branches that transitively wait for
 *   it, so a failed scaffold still blocks everything.
 * - `off` carries on.
 */
export function onBranchNotMerged(
    plan: DispatchPlan,
    branch: string,
    policy: DispatchHaltPolicy,
): { halt: boolean; skip: string[] } {
    const isScaffold = plan.branches.get(branch)?.kind === 'scaffold';
    if (policy === 'strict' || (policy === 'scaffold-only' && isScaffold)) return { halt: true, skip: [] };
    return { halt: false, skip: policy === 'dependents' ? transitiveDependents(plan, branch) : [] };
}

/** One log / finding line for an edge removed to break a cycle. */
export function describeBrokenEdge(e: BrokenEdge): string {
    if (e.level === 'assignment') {
        return `Dependency cycle among [${e.cycle.join(', ')}]: dropped "${e.from} dependsOn ${e.to}" — ${e.from} will not wait for ${e.to}`;
    }
    const via = (e.via ?? []).map(v => `${v.from} dependsOn ${v.to}`).join(', ');
    return `Branch cycle among [${e.cycle.join(', ')}]: ${e.from} will not wait for ${e.to}${via ? ` (${via})` : ''} and may start before it merges`;
}

/** JSON-friendly plan summary for the `dispatch:plan` event and the `dispatch-plan` ledger entry. */
export function summariseDispatchPlan(plan: DispatchPlan): DispatchPlanRecord {
    return {
        branches: plan.branchOrder.map(name => {
            const b = plan.branches.get(name)!;
            return { name, kind: b.kind, reason: b.reason, assignments: b.assignments.map(a => a.id), dependsOn: b.dependsOnBranches };
        }),
        order: plan.branchOrder,
        layers: plan.layers,
        skippedEdges: plan.skippedEdges,
        brokenEdges: plan.brokenEdges,
        warnings: plan.warnings,
    };
}
