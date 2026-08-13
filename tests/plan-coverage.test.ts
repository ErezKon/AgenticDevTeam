/**
 * Tests for plan-coverage.ts — validates that the coverage gate correctly
 * detects silent scope loss between PM and TL planning phases.
 */
import { validateStoryPlan, validateAssignmentPlan, buildCoverageGapPrompt } from '../src/conductor/plan-coverage';
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

// ─── buildCoverageGapPrompt ─────────────────────────────────────────────────

describe('buildCoverageGapPrompt', () => {
    it('produces a prompt listing unassigned stories and tasks', () => {
        const violations = [
            { kind: 'story-without-assignment' as const, severity: 'critical' as const, id: 'US-003', detail: 'Story US-003: not assigned' },
            { kind: 'task-without-assignment' as const, severity: 'critical' as const, id: 'TASK-005', detail: 'Task TASK-005: not assigned' },
        ];
        const prompt = buildCoverageGapPrompt(violations, 5);
        expect(prompt).toContain('US-003');
        expect(prompt).toContain('TASK-005');
        expect(prompt).toContain('ASSIGN-005');
    });
});
