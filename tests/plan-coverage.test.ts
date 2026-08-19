/**
 * Tests for plan-coverage.ts — validates that the coverage gate correctly
 * detects silent scope loss between PM and TL planning phases.
 */
import { validateStoryPlan, validateAssignmentPlan, buildCoverageGapPrompt } from '../src/conductor/plan-coverage';
import type { GapRepairContext } from '../src/conductor/plan-coverage';
import type { ProjectStateType } from '../src/conductor/state';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ProjectStateType> = {}): ProjectStateType {
    return {
        epics: [{ id: 'E-001', title: 'MVP', description: 'MVP epic' }],
        userStories: [
            {
                id: 'US-001', epicId: 'E-001',
                asA: 'user', iWant: 'login', soThat: 'I can access the system',
                acceptanceCriteria: ['AC0: valid credentials work', 'AC1: invalid rejected'],
            },
            {
                id: 'US-002', epicId: 'E-001',
                asA: 'admin', iWant: 'manage users', soThat: 'roles are enforced',
                acceptanceCriteria: ['AC0: add user', 'AC1: remove user'],
            },
        ],
        tasks: [
            { id: 'TASK-001', storyId: 'US-001', title: 'Auth endpoint', layer: 'backend', suggestedTech: 'Node', description: 'Build auth' },
            { id: 'TASK-002', storyId: 'US-002', title: 'Admin UI', layer: 'frontend', suggestedTech: 'React', description: 'Build admin' },
        ],
        assignments: [
            {
                id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                devAgentId: 'senior-backend', rank: 'senior', priority: 'high', complexity: 'moderate',
                estimate: '4h', description: 'Build auth', dependsOn: [], taskType: 'feature',
            },
            {
                id: 'ASSIGN-002', storyId: 'US-002', additionalStoryIds: [], taskIds: ['TASK-002'], acIndexes: [],
                devAgentId: 'senior-react', rank: 'senior', priority: 'medium', complexity: 'moderate',
                estimate: '4h', description: 'Build admin', dependsOn: ['ASSIGN-001'], taskType: 'feature',
            },
        ],
        ...overrides,
    } as unknown as ProjectStateType;
}

// ─── validateStoryPlan ──────────────────────────────────────────────────────

describe('validateStoryPlan', () => {
    it('returns no violations for a well-formed plan', () => {
        const state = makeState();
        expect(validateStoryPlan(state)).toEqual([]);
    });

    it('detects story-without-task', () => {
        const state = makeState({
            tasks: [
                { id: 'TASK-001', storyId: 'US-001', title: 'Auth', layer: 'backend', suggestedTech: 'Node', description: '' },
            ] as any,
        });
        const v = validateStoryPlan(state);
        expect(v).toHaveLength(1);
        expect(v[0].kind).toBe('story-without-task');
        expect(v[0].id).toBe('US-002');
    });

    it('detects epic-without-story', () => {
        const state = makeState({
            epics: [
                { id: 'E-001', title: 'MVP', description: '' },
                { id: 'E-002', title: 'Phase 2', description: '' },
            ] as any,
        });
        const v = validateStoryPlan(state);
        expect(v.some(vi => vi.kind === 'epic-without-story' && vi.id === 'E-002')).toBe(true);
    });

    it('detects dangling epicId in story', () => {
        const state = makeState({
            userStories: [
                {
                    id: 'US-001', epicId: 'E-GONE',
                    asA: 'user', iWant: 'login', soThat: 'access',
                    acceptanceCriteria: ['AC'],
                },
            ] as any,
        });
        const v = validateStoryPlan(state);
        expect(v.some(vi => vi.kind === 'dangling-story-ref')).toBe(true);
    });
});

// ─── validateAssignmentPlan ─────────────────────────────────────────────────

describe('validateAssignmentPlan', () => {
    it('returns no violations for a complete assignment plan', () => {
        const state = makeState();
        expect(validateAssignmentPlan(state)).toEqual([]);
    });

    it('detects story-without-assignment', () => {
        const state = makeState({
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'senior-backend', rank: 'senior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'Build auth', dependsOn: [], taskType: 'feature',
                },
                // US-002 missing
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const storyCov = v.filter(vi => vi.kind === 'story-without-assignment');
        expect(storyCov).toHaveLength(1);
        expect(storyCov[0].id).toBe('US-002');
    });

    it('detects task-without-assignment', () => {
        const state = makeState({
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: ['US-002'],
                    taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'senior-backend', rank: 'senior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'Build auth + admin', dependsOn: [], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const taskCov = v.filter(vi => vi.kind === 'task-without-assignment');
        expect(taskCov).toHaveLength(1);
        expect(taskCov[0].id).toBe('TASK-002');
    });

    it('additionalStoryIds counts as coverage', () => {
        const state = makeState({
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: ['US-002'],
                    taskIds: ['TASK-001', 'TASK-002'], acIndexes: [],
                    devAgentId: 'senior-backend', rank: 'senior', priority: 'high', complexity: 'moderate',
                    estimate: '8h', description: 'Build both', dependsOn: [], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const storyCov = v.filter(vi => vi.kind === 'story-without-assignment');
        expect(storyCov).toHaveLength(0);
    });

    it('detects dangling dependsOn', () => {
        const state = makeState({
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'senior-backend', rank: 'senior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'Auth', dependsOn: ['ASSIGN-GHOST'], taskType: 'feature',
                },
                {
                    id: 'ASSIGN-002', storyId: 'US-002', additionalStoryIds: [], taskIds: ['TASK-002'], acIndexes: [],
                    devAgentId: 'senior-react', rank: 'senior', priority: 'medium', complexity: 'moderate',
                    estimate: '4h', description: 'Admin', dependsOn: ['ASSIGN-001'], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        expect(v.some(vi => vi.kind === 'dangling-dependency')).toBe(true);
    });

    it('detects dangling storyId in assignment', () => {
        const state = makeState({
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-GHOST', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'senior-backend', rank: 'senior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'Auth', dependsOn: [], taskType: 'feature',
                },
                {
                    id: 'ASSIGN-002', storyId: 'US-002', additionalStoryIds: [], taskIds: ['TASK-002'], acIndexes: [],
                    devAgentId: 'senior-react', rank: 'senior', priority: 'medium', complexity: 'moderate',
                    estimate: '4h', description: 'Admin', dependsOn: [], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        expect(v.some(vi => vi.kind === 'dangling-story-ref')).toBe(true);
    });
});

// ─── Plan 26, B2: scope feasibility checks ─────────────────────────────────

describe('validateAssignmentPlan — scope feasibility (Plan 26, B2)', () => {
    it('flags oversized assignments (complex + 3d estimate)', () => {
        const state = makeState({
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'principal-frontend', rank: 'principal', priority: 'high', complexity: 'complex',
                    estimate: '3d', description: 'Build everything', dependsOn: [], taskType: 'chore',
                },
                {
                    id: 'ASSIGN-002', storyId: 'US-002', additionalStoryIds: [], taskIds: ['TASK-002'], acIndexes: [],
                    devAgentId: 'senior-frontend', rank: 'senior', priority: 'medium', complexity: 'moderate',
                    estimate: '4h', description: 'Build admin', dependsOn: [], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const oversized = v.filter(vi => vi.kind === 'oversized-assignment');
        expect(oversized).toHaveLength(1);
        expect(oversized[0].id).toBe('ASSIGN-001');
    });

    it('does not flag moderate assignments', () => {
        const state = makeState();
        const v = validateAssignmentPlan(state);
        expect(v.filter(vi => vi.kind === 'oversized-assignment')).toHaveLength(0);
    });

    it('flags very-complex + 5d estimate', () => {
        const state = makeState({
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: ['US-002'],
                    taskIds: ['TASK-001', 'TASK-002'], acIndexes: [],
                    devAgentId: 'principal-frontend', rank: 'principal', priority: 'critical',
                    complexity: 'very-complex', estimate: '5d', description: 'All tasks', dependsOn: [],
                    taskType: 'chore',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const oversized = v.filter(vi => vi.kind === 'oversized-assignment');
        expect(oversized.length).toBeGreaterThanOrEqual(1);
    });

    it('flags agent-overloaded when >6 tasks on one branch', () => {
        const tasks = Array.from({ length: 8 }, (_, i) => `TASK-${String(i + 1).padStart(3, '0')}`);
        const state = makeState({
            tasks: [
                { id: 'TASK-001', storyId: 'US-001', title: 'T1', layer: 'backend', suggestedTech: 'Node', description: '' },
                { id: 'TASK-002', storyId: 'US-002', title: 'T2', layer: 'frontend', suggestedTech: 'React', description: '' },
            ] as any,
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: ['US-002'],
                    taskIds: tasks, acIndexes: [],
                    devAgentId: 'senior-backend', rank: 'senior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'All tasks',
                    dependsOn: [], taskType: 'feature', branchName: 'proj/feat/us-001',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const overloaded = v.filter(vi => vi.kind === 'agent-overloaded');
        expect(overloaded.length).toBeGreaterThanOrEqual(1);
        expect(overloaded[0].detail).toContain('senior-backend');
    });

    it('does not flag agent-overloaded when <= 6 tasks', () => {
        const state = makeState();
        const v = validateAssignmentPlan(state);
        expect(v.filter(vi => vi.kind === 'agent-overloaded')).toHaveLength(0);
    });
});

// ─── buildCoverageGapPrompt ─────────────────────────────────────────────────

describe('buildCoverageGapPrompt', () => {
    it('produces a prompt listing unassigned stories and tasks (legacy signature)', () => {
        const violations = [
            { kind: 'story-without-assignment' as const, severity: 'critical' as const, id: 'US-003', detail: 'Story US-003: not assigned' },
            { kind: 'task-without-assignment' as const, severity: 'critical' as const, id: 'TASK-005', detail: 'Task TASK-005: not assigned' },
        ];
        const prompt = buildCoverageGapPrompt(violations, 5);
        expect(prompt).toContain('US-003');
        expect(prompt).toContain('TASK-005');
        expect(prompt).toContain('ASSIGN-005');
    });

    it('includes project slug, tech stack, and existing assignments when provided (Plan 27-D)', () => {
        const violations = [
            { kind: 'story-without-assignment' as const, severity: 'critical' as const, id: 'US-010', detail: 'Story US-010: not assigned' },
        ];
        const ctx: GapRepairContext = {
            violations,
            nextAssignmentId: 9,
            projectSlug: 'pacmanclaude4',
            techStack: '- frontend: React\n- styling: Tailwind CSS',
            repoContract: 'layout: monorepo\nroots: src/',
            existingAssignments: 'ASSIGN-001: [senior-frontend] branch=pacmanclaude4/chore/scaffold',
            existingBranches: ['pacmanclaude4/chore/scaffold', 'pacmanclaude4/feature/us-001'],
        };
        const prompt = buildCoverageGapPrompt(ctx);
        expect(prompt).toContain('pacmanclaude4');
        expect(prompt).toContain('pacmanclaude4/chore/scaffold');
        expect(prompt).toContain('pacmanclaude4/feature/us-001');
        expect(prompt).toContain('React');
        expect(prompt).toContain('Tailwind CSS');
        expect(prompt).toContain('layout: monorepo');
        expect(prompt).toContain('ASSIGN-001');
        expect(prompt).toContain('DO NOT restate');
        expect(prompt).toContain('ASSIGN-009');
        expect(prompt).toContain('US-010');
        // Should warn about backend agents on frontend tech stack
        expect(prompt).toContain('Do NOT assign backend-only agents');
    });

    it('includes off-stack-agent violations in gap prompt (Plan 27-E)', () => {
        const violations = [
            { kind: 'off-stack-agent' as const, severity: 'major' as const, id: 'ASSIGN-005', detail: 'Assignment ASSIGN-005 assigns junior-python (backend/Python) to a frontend-only project' },
        ];
        const prompt = buildCoverageGapPrompt(violations, 6);
        expect(prompt).toContain('Off-Stack Agent Assignments');
        expect(prompt).toContain('junior-python');
        expect(prompt).toContain('Reassign these to agents whose domain');
    });
});

// ─── Plan 27-E: Off-stack agent detection ───────────────────────────────────

describe('validateAssignmentPlan — off-stack agent detection (Plan 27-E)', () => {
    it('flags junior-python on a React-only (frontend-only) project', () => {
        const state = makeState({
            techStack: [
                { layer: 'frontend', choice: 'React', rationale: 'SPA' },
                { layer: 'styling', choice: 'Tailwind', rationale: 'utility CSS' },
            ] as any,
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'junior-python', rank: 'junior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'Build login form', dependsOn: [], taskType: 'feature',
                },
                {
                    id: 'ASSIGN-002', storyId: 'US-002', additionalStoryIds: [], taskIds: ['TASK-002'], acIndexes: [],
                    devAgentId: 'junior-react', rank: 'junior', priority: 'medium', complexity: 'moderate',
                    estimate: '4h', description: 'Build admin', dependsOn: [], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const offStack = v.filter(vi => vi.kind === 'off-stack-agent');
        expect(offStack).toHaveLength(1);
        expect(offStack[0].id).toBe('ASSIGN-001');
        expect(offStack[0].detail).toContain('junior-python');
        expect(offStack[0].detail).toContain('frontend-only project');
    });

    it('does NOT flag junior-python on a Python project', () => {
        const state = makeState({
            techStack: [
                { layer: 'backend', choice: 'Python', rationale: 'FastAPI' },
                { layer: 'database', choice: 'PostgreSQL', rationale: 'relational' },
            ] as any,
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'junior-python', rank: 'junior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'Build API', dependsOn: [], taskType: 'feature',
                },
                {
                    id: 'ASSIGN-002', storyId: 'US-002', additionalStoryIds: [], taskIds: ['TASK-002'], acIndexes: [],
                    devAgentId: 'senior-backend', rank: 'senior', priority: 'medium', complexity: 'moderate',
                    estimate: '4h', description: 'Build admin API', dependsOn: [], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const offStack = v.filter(vi => vi.kind === 'off-stack-agent');
        expect(offStack).toHaveLength(0);
    });

    it('does NOT flag junior-python on a fullstack project (both frontend + backend)', () => {
        const state = makeState({
            techStack: [
                { layer: 'frontend', choice: 'React', rationale: 'SPA' },
                { layer: 'backend', choice: 'Python', rationale: 'FastAPI' },
            ] as any,
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'junior-python', rank: 'junior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'Build API', dependsOn: [], taskType: 'feature',
                },
                {
                    id: 'ASSIGN-002', storyId: 'US-002', additionalStoryIds: [], taskIds: ['TASK-002'], acIndexes: [],
                    devAgentId: 'junior-react', rank: 'junior', priority: 'medium', complexity: 'moderate',
                    estimate: '4h', description: 'Build admin UI', dependsOn: [], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const offStack = v.filter(vi => vi.kind === 'off-stack-agent');
        expect(offStack).toHaveLength(0);
    });

    it('flags junior-react on a backend-only (Go) project', () => {
        const state = makeState({
            techStack: [
                { layer: 'backend', choice: 'Go', rationale: 'performance' },
            ] as any,
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'junior-react', rank: 'junior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'Build API handler', dependsOn: [], taskType: 'feature',
                },
                {
                    id: 'ASSIGN-002', storyId: 'US-002', additionalStoryIds: [], taskIds: ['TASK-002'], acIndexes: [],
                    devAgentId: 'junior-go', rank: 'junior', priority: 'medium', complexity: 'moderate',
                    estimate: '4h', description: 'Build service', dependsOn: [], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const offStack = v.filter(vi => vi.kind === 'off-stack-agent');
        expect(offStack).toHaveLength(1);
        expect(offStack[0].detail).toContain('junior-react');
        expect(offStack[0].detail).toContain('backend-only project');
    });

    it('does NOT flag senior agents (they are cross-domain capable)', () => {
        const state = makeState({
            techStack: [
                { layer: 'frontend', choice: 'React', rationale: 'SPA' },
            ] as any,
            assignments: [
                {
                    id: 'ASSIGN-001', storyId: 'US-001', additionalStoryIds: [], taskIds: ['TASK-001'], acIndexes: [],
                    devAgentId: 'senior-backend', rank: 'senior', priority: 'high', complexity: 'moderate',
                    estimate: '4h', description: 'Build API adapter', dependsOn: [], taskType: 'feature',
                },
                {
                    id: 'ASSIGN-002', storyId: 'US-002', additionalStoryIds: [], taskIds: ['TASK-002'], acIndexes: [],
                    devAgentId: 'senior-frontend', rank: 'senior', priority: 'medium', complexity: 'moderate',
                    estimate: '4h', description: 'Build UI', dependsOn: [], taskType: 'feature',
                },
            ] as any,
        });
        const v = validateAssignmentPlan(state);
        const offStack = v.filter(vi => vi.kind === 'off-stack-agent');
        expect(offStack).toHaveLength(0);
    });
});
