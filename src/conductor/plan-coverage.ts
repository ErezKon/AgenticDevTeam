/**
 * Plan coverage validator — detects silent scope loss between planning phases.
 *
 * Two validators:
 * - `validateStoryPlan`:      epics → stories → tasks  (after Product Manager)
 * - `validateAssignmentPlan`: stories/tasks → assignments  (after Team Leader)
 *
 * Both return a list of `CoverageViolation` objects graded critical or major.
 * The conductor can then re-invoke the planning agent with a targeted gap prompt
 * or (under PLAN_COVERAGE_MODE='enforce') fail the run early.
 */
import type { ProjectStateType } from './state';
import { getLogger } from '../utils/logger';
import { getDevAgent } from '../agents/developers/registry';

const log = getLogger('[plan-coverage]', 213);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CoverageViolation {
    kind:
        | 'story-without-task'
        | 'task-without-assignment'
        | 'story-without-assignment'
        | 'ac-without-assignment'
        | 'dangling-story-ref'
        | 'dangling-task-ref'
        | 'dangling-dependency'
        | 'epic-without-story'
        | 'duplicate-id'
        | 'oversized-assignment'
        | 'agent-overloaded'
        | 'off-stack-agent';
    severity: 'critical' | 'major';
    id: string;
    detail: string;
}

// ─── Story Plan Validator (after PM) ────────────────────────────────────────

/**
 * Validate epics → stories → tasks.
 * Called at the end of productManagerNode.
 */
export function validateStoryPlan(state: ProjectStateType): CoverageViolation[] {
    const violations: CoverageViolation[] = [];

    const epicIds = new Set((state.epics ?? []).map(e => e.id));
    const storyIds = new Set((state.userStories ?? []).map(s => s.id));
    const taskStoryIds = new Set<string>();

    // Detect duplicate story ids
    const seenStoryIds = new Set<string>();
    for (const s of state.userStories ?? []) {
        if (seenStoryIds.has(s.id)) {
            violations.push({ kind: 'duplicate-id', severity: 'major', id: s.id, detail: `Duplicate user story id: ${s.id}` });
        }
        seenStoryIds.add(s.id);
    }

    // Detect duplicate task ids
    const seenTaskIds = new Set<string>();
    for (const t of state.tasks ?? []) {
        if (seenTaskIds.has(t.id)) {
            violations.push({ kind: 'duplicate-id', severity: 'major', id: t.id, detail: `Duplicate task id: ${t.id}` });
        }
        seenTaskIds.add(t.id);
        if (t.storyId) taskStoryIds.add(t.storyId);
    }

    // Every epic should have at least one story
    for (const epic of state.epics ?? []) {
        const hasStory = (state.userStories ?? []).some(s => s.epicId === epic.id);
        if (!hasStory) {
            violations.push({ kind: 'epic-without-story', severity: 'major', id: epic.id, detail: `Epic ${epic.id} has no user stories` });
        }
    }

    // Every story's epicId should resolve
    for (const s of state.userStories ?? []) {
        if (s.epicId && !epicIds.has(s.epicId)) {
            violations.push({ kind: 'dangling-story-ref', severity: 'major', id: s.id, detail: `Story ${s.id} references non-existent epic ${s.epicId}` });
        }
    }

    // Every story should have at least one task
    for (const s of state.userStories ?? []) {
        if (!taskStoryIds.has(s.id)) {
            violations.push({ kind: 'story-without-task', severity: 'critical', id: s.id, detail: `Story ${s.id} has no tasks` });
        }
    }

    // Every task's storyId (if present) should resolve
    for (const t of state.tasks ?? []) {
        if (t.storyId && !storyIds.has(t.storyId)) {
            violations.push({ kind: 'dangling-task-ref', severity: 'major', id: t.id, detail: `Task ${t.id} references non-existent story ${t.storyId}` });
        }
    }

    return violations;
}

// ─── Assignment Plan Validator (after TL) ───────────────────────────────────

/**
 * Validate stories/tasks → assignments.
 * Called at the end of teamLeaderNode.
 */
export function validateAssignmentPlan(state: ProjectStateType): CoverageViolation[] {
    const violations: CoverageViolation[] = [];

    const storyIds = new Set((state.userStories ?? []).map(s => s.id));
    const taskIds = new Set((state.tasks ?? []).map(t => t.id));
    const assignmentIds = new Set<string>();

    // Collect all story ids covered by assignments (primary + additional)
    const coveredStoryIds = new Set<string>();
    // Collect all task ids covered by assignments
    const coveredTaskIds = new Set<string>();
    // Track AC coverage: storyId → Set<acIndex>
    const coveredAcByStory = new Map<string, Set<number>>();

    // Detect duplicate assignment ids
    const seenIds = new Set<string>();
    for (const a of state.assignments ?? []) {
        if (seenIds.has(a.id)) {
            violations.push({ kind: 'duplicate-id', severity: 'major', id: a.id, detail: `Duplicate assignment id: ${a.id}` });
        }
        seenIds.add(a.id);
        assignmentIds.add(a.id);

        // Primary story
        coveredStoryIds.add(a.storyId);

        // Additional stories
        for (const sid of a.additionalStoryIds ?? []) {
            coveredStoryIds.add(sid);
        }

        // Task ids
        for (const tid of a.taskIds ?? []) {
            coveredTaskIds.add(tid);
        }

        // AC indexes
        const allStoryIds = [a.storyId, ...(a.additionalStoryIds ?? [])];
        for (const sid of allStoryIds) {
            if (!coveredAcByStory.has(sid)) coveredAcByStory.set(sid, new Set());
            const acSet = coveredAcByStory.get(sid)!;
            if ((a.acIndexes ?? []).length === 0) {
                // Empty acIndexes = covers all AC for this story
                acSet.add(-1); // sentinel for "all"
            } else {
                for (const idx of a.acIndexes ?? []) acSet.add(idx);
            }
        }
    }

    // Every story should be assigned
    for (const s of state.userStories ?? []) {
        if (!coveredStoryIds.has(s.id)) {
            const acCount = s.acceptanceCriteria?.length ?? 0;
            violations.push({
                kind: 'story-without-assignment',
                severity: 'critical',
                id: s.id,
                detail: `Story ${s.id} (${acCount} AC): "As a ${s.asA}, I want ${s.iWant}" — has no assignment`,
            });
        }
    }

    // Every task should be assigned
    for (const t of state.tasks ?? []) {
        if (!coveredTaskIds.has(t.id)) {
            violations.push({
                kind: 'task-without-assignment',
                severity: 'critical',
                id: t.id,
                detail: `Task ${t.id} [${t.layer}] "${t.title}" — unassigned`,
            });
        }
    }

    // Every AC of every story should be covered
    for (const s of state.userStories ?? []) {
        const acSet = coveredAcByStory.get(s.id);
        if (!acSet) continue; // story-without-assignment already reported
        if (acSet.has(-1)) continue; // "all" sentinel covers everything
        const acCount = s.acceptanceCriteria?.length ?? 0;
        for (let i = 0; i < acCount; i++) {
            if (!acSet.has(i)) {
                violations.push({
                    kind: 'ac-without-assignment',
                    severity: 'major',
                    id: `${s.id}:AC${i}`,
                    detail: `Story ${s.id} AC[${i}]: "${(s.acceptanceCriteria ?? [])[i]}" — not covered by any assignment's acIndexes`,
                });
            }
        }
    }

    // Every assignment.storyId / additionalStoryIds should resolve
    for (const a of state.assignments ?? []) {
        if (!storyIds.has(a.storyId) && a.storyId !== 'US-BUGFIX') {
            violations.push({
                kind: 'dangling-story-ref',
                severity: 'critical',
                id: a.id,
                detail: `Assignment ${a.id} references non-existent story ${a.storyId}`,
            });
        }
        for (const sid of a.additionalStoryIds ?? []) {
            if (!storyIds.has(sid)) {
                violations.push({
                    kind: 'dangling-story-ref',
                    severity: 'major',
                    id: a.id,
                    detail: `Assignment ${a.id} additionalStoryIds references non-existent story ${sid}`,
                });
            }
        }

        // Every taskIds entry should resolve (skip BUGFIX- prefixed tasks)
        for (const tid of a.taskIds ?? []) {
            if (!taskIds.has(tid) && !tid.startsWith('BUGFIX-')) {
                violations.push({
                    kind: 'dangling-task-ref',
                    severity: 'major',
                    id: a.id,
                    detail: `Assignment ${a.id} references non-existent task ${tid}`,
                });
            }
        }

        // Every dependsOn entry should resolve
        for (const dep of a.dependsOn ?? []) {
            if (!assignmentIds.has(dep)) {
                violations.push({
                    kind: 'dangling-dependency',
                    severity: 'critical',
                    id: a.id,
                    detail: `Assignment ${a.id} dependsOn non-existent assignment ${dep}`,
                });
            }
        }
    }

    // ── Plan 26, B2: Scope feasibility — flag oversized assignments ──────
    const COMPLEXITY_CONCERN_THRESHOLD = new Set(['complex', 'very-complex']);
    const ESTIMATE_CONCERN_RE = /^[3-9]d$|^\d{2,}d$/; // 3d+ or 10d+

    for (const a of state.assignments ?? []) {
        // Flag assignments that are both complex AND have high estimates
        if (COMPLEXITY_CONCERN_THRESHOLD.has(a.complexity) && ESTIMATE_CONCERN_RE.test(a.estimate)) {
            violations.push({
                kind: 'oversized-assignment',
                severity: 'major',
                id: a.id,
                detail: `Assignment ${a.id} is ${a.complexity} with estimate ${a.estimate} — consider splitting into smaller assignments`,
            });
        }

        // Flag agents with too many tasks on one branch
        const agentAssignmentsOnBranch = (state.assignments ?? [])
            .filter(other => other.devAgentId === a.devAgentId && other.branchName === a.branchName);
        const totalTasks = agentAssignmentsOnBranch.reduce((sum, o) => sum + (o.taskIds?.length ?? 0), 0);
        if (totalTasks > 6) {
            // Deduplicate: only report once per agent+branch pair
            const agentBranchKey = `${a.devAgentId}:${a.branchName}`;
            const alreadyReported = violations.some(
                v => v.kind === 'agent-overloaded' && v.id === agentBranchKey,
            );
            if (!alreadyReported) {
                violations.push({
                    kind: 'agent-overloaded',
                    severity: 'major',
                    id: agentBranchKey,
                    detail: `Agent ${a.devAgentId} has ${totalTasks} tasks on branch ${a.branchName} — risk of budget exhaustion`,
                });
            }
        }
    }

    // ── Plan 27-E: Off-stack agent detection — flag junior agents assigned outside their domain ──
    const stackChoices = new Set<string>();
    const stackLayers = new Set<string>();
    for (const tech of state.techStack ?? []) {
        stackChoices.add((tech.choice ?? '').toLowerCase());
        stackLayers.add((tech.layer ?? '').toLowerCase());
    }

    // Determine if the project is frontend-only, backend-only, or fullstack
    const frontendChoices = ['react', 'angular', 'vue', 'svelte', 'typescript', 'html/css', 'tailwind'];
    const backendChoices = ['python', 'java', 'go', 'c#', 'c#/.net', 'node.js', 'express', 'fastapi', 'django', 'spring'];
    const hasFrontend = stackLayers.has('frontend') || stackLayers.has('styling') ||
                        frontendChoices.some(c => stackChoices.has(c));
    const hasBackend = stackLayers.has('backend') ||
                       backendChoices.some(c => stackChoices.has(c));

    for (const a of state.assignments ?? []) {
        const entry = getDevAgent(a.devAgentId);
        if (!entry) continue;

        // Flag backend-only juniors on frontend-only projects
        if (entry.domain === 'backend' && entry.rank === 'junior' && hasFrontend && !hasBackend) {
            violations.push({
                kind: 'off-stack-agent',
                severity: 'major',
                id: a.id,
                detail: `Assignment ${a.id} assigns ${a.devAgentId} (backend/${entry.languages.join(',')}) ` +
                        `to a frontend-only project — reassign to a frontend agent`,
            });
        }

        // Flag frontend-only juniors on backend-only projects
        if (entry.domain === 'frontend' && entry.rank === 'junior' && hasBackend && !hasFrontend) {
            violations.push({
                kind: 'off-stack-agent',
                severity: 'major',
                id: a.id,
                detail: `Assignment ${a.id} assigns ${a.devAgentId} (frontend/${entry.languages.join(',')}) ` +
                        `to a backend-only project — reassign to a backend agent`,
            });
        }
    }

    return violations;
}

// ─── Gap Repair Context (Plan 27-D) ────────────────────────────────────────

/** Context passed to gap-repair to prevent blind assignment generation. */
export interface GapRepairContext {
    /** Violations that triggered the gap repair */
    violations: CoverageViolation[];
    /** Next assignment ID to continue from */
    nextAssignmentId: number;
    /** Project slug for branch naming */
    projectSlug?: string;
    /** Tech stack decisions from the architect */
    techStack?: string;
    /** Repo contract summary */
    repoContract?: string;
    /** Assignments already produced in the first TL call */
    existingAssignments?: string;
    /** Branch names already created */
    existingBranches?: string[];
}

// ─── Gap Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build a targeted gap prompt for the TL to close coverage gaps.
 * Returns only the additions needed, not the full plan.
 *
 * Plan 27-D: accepts a GapRepairContext with project slug, tech stack, repo contract,
 * and existing assignments to prevent blind assignment generation.
 */
export function buildCoverageGapPrompt(
    violationsOrCtx: CoverageViolation[] | GapRepairContext,
    nextAssignmentId?: number,
): string {
    // Support both legacy (violations, nextId) and new (GapRepairContext) signatures
    let violations: CoverageViolation[];
    let nextId: number;
    let projectSlug: string | undefined;
    let techStack: string | undefined;
    let repoContract: string | undefined;
    let existingAssignments: string | undefined;
    let existingBranches: string[] | undefined;

    if (Array.isArray(violationsOrCtx)) {
        violations = violationsOrCtx;
        nextId = nextAssignmentId ?? 1;
    } else {
        violations = violationsOrCtx.violations;
        nextId = violationsOrCtx.nextAssignmentId;
        projectSlug = violationsOrCtx.projectSlug;
        techStack = violationsOrCtx.techStack;
        repoContract = violationsOrCtx.repoContract;
        existingAssignments = violationsOrCtx.existingAssignments;
        existingBranches = violationsOrCtx.existingBranches;
    }

    const parts: string[] = [];

    // Include critical context that the gap-repair agent needs (Plan 27-D)
    if (projectSlug) {
        parts.push(`## Project Slug: ${projectSlug}`);
        parts.push(`All branch names MUST start with "${projectSlug}/". Examples:`);
        parts.push(`  - "${projectSlug}/chore/scaffold" for scaffold work`);
        parts.push(`  - "${projectSlug}/feature/us-001-description" for features`);
        parts.push('');
    }

    if (techStack) {
        parts.push(`## Tech Stack (from Architect)`);
        parts.push(techStack);
        parts.push('');
        parts.push('IMPORTANT: Match developer expertise to this tech stack. Do NOT assign backend-only agents (junior-python, junior-java, junior-go, junior-csharp) to frontend/TypeScript tasks.');
        parts.push('');
    }

    if (repoContract) {
        parts.push(`## Repo Contract`);
        parts.push(repoContract);
        parts.push('');
    }

    if (existingAssignments) {
        parts.push(`## Already-Produced Assignments`);
        parts.push('These assignments were already generated. DO NOT restate them.');
        parts.push(existingAssignments);
        parts.push('');
    }

    if (existingBranches?.length) {
        parts.push(`## Existing Branches`);
        parts.push('These branches already exist. Reuse them when assigning stories to the same branch.');
        for (const b of existingBranches) parts.push(`  - ${b}`);
        parts.push('');
    }

    parts.push('---');
    parts.push('');
    parts.push('Your assignment plan is incomplete. The following gaps MUST be closed:');
    parts.push('');

    const storyGaps = violations.filter(v => v.kind === 'story-without-assignment');
    const taskGaps = violations.filter(v => v.kind === 'task-without-assignment');
    const danglingDeps = violations.filter(v => v.kind === 'dangling-dependency');
    const oversized = violations.filter(v => v.kind === 'oversized-assignment');
    const overloaded = violations.filter(v => v.kind === 'agent-overloaded');
    const offStack = violations.filter(v => v.kind === 'off-stack-agent');

    if (storyGaps.length > 0) {
        parts.push(`## Unassigned stories (${storyGaps.length}):`);
        for (const v of storyGaps) parts.push(`  ${v.detail}`);
        parts.push('');
    }

    if (taskGaps.length > 0) {
        parts.push(`## Unassigned tasks (${taskGaps.length}):`);
        for (const v of taskGaps) parts.push(`  ${v.detail}`);
        parts.push('');
    }

    if (danglingDeps.length > 0) {
        parts.push(`## Dangling dependsOn ids (${danglingDeps.length}):`);
        for (const v of danglingDeps) parts.push(`  ${v.detail}`);
        parts.push('');
    }

    // Plan 26, B2: scope feasibility feedback
    if (oversized.length > 0) {
        parts.push(`## Oversized assignments (${oversized.length}):`);
        for (const v of oversized) parts.push(`  ${v.detail}`);
        parts.push('Split these into smaller assignments with sequential dependsOn.');
        parts.push('');
    }

    if (overloaded.length > 0) {
        parts.push(`## Agent overload (${overloaded.length}):`);
        for (const v of overloaded) parts.push(`  ${v.detail}`);
        parts.push('Redistribute tasks across agents or split into separate assignments.');
        parts.push('');
    }

    // Plan 27-E: off-stack agent feedback
    if (offStack.length > 0) {
        parts.push(`## Off-Stack Agent Assignments (${offStack.length}):`);
        for (const v of offStack) parts.push(`  ${v.detail}`);
        parts.push('Reassign these to agents whose domain and languages match the project tech stack.');
        parts.push('');
    }

    parts.push(
        `Return ONLY the ADDITIONAL assignments needed to close these gaps, as`,
        `{ "assignments": [ ...the remaining items... ] }`,
        `Continue the id sequence from ASSIGN-${String(nextId).padStart(3, '0')}.`,
        `Do not restate assignments you already produced.`,
    );

    return parts.join('\n');
}

/**
 * Log the planning funnel at the end of teamLeaderNode.
 */
export function logPlanFunnel(state: ProjectStateType): void {
    const epicCount = (state.epics ?? []).length;
    const storyCount = (state.userStories ?? []).length;
    const acCount = (state.userStories ?? []).reduce((sum, s) => sum + (s.acceptanceCriteria?.length ?? 0), 0);
    const taskCount = (state.tasks ?? []).length;
    const assignmentCount = (state.assignments ?? []).length;
    log.info(`Plan funnel: ${epicCount} epics → ${storyCount} stories (${acCount} AC) → ${taskCount} tasks → ${assignmentCount} assignments`);
}
