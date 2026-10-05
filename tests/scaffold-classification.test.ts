/**
 * Scaffold branch classification (Plan 22, F1; Plan 30-01).
 *
 * ## The bugs these tests pin
 *
 * Plan 22 F1: `isScaffoldAssignment` matched `/\/chore\/scaffold$/i`, which requires a
 * leading slash. The Team Leader emits un-prefixed branch names (`chore/scaffold`); the
 * dispatcher adds the `<project>/` prefix later. And `scaffoldBranches` required
 * `every` assignment on the branch to look like scaffold work, so one
 * `refactor`-typed assignment sharing the branch disabled the barrier entirely.
 *
 * Plan 30-01: the fix for that over-corrected — any `taskType: 'chore'` assignment, and
 * any branch carrying one (`.some()`), counted as scaffold. In the claudeopus5 run a
 * `chore`-typed asset audit made a seven-assignment feature branch "the scaffold", so it
 * ran first, before the branches it depended on. Only the branch name decides now.
 */
import {
    SCAFFOLD_BRANCH_RE, isScaffoldAssignment, isScaffoldBranch, buildDispatchPlan,
} from '../src/agents/developers/dispatch-plan';
import type { Assignment } from '../src/agents/_shared/base-schemas';

function assignment(over: Partial<Assignment> = {}): Assignment {
    return {
        id: 'ASSIGN-001',
        taskIds: ['TASK-001'],
        storyId: 'US-014',
        devAgentId: 'principal-frontend',
        description: 'Scaffold the Vite PWA',
        taskType: 'chore',
        branchName: 'chore/scaffold',
        dependsOn: [],
        ...over,
    } as Assignment;
}

describe('SCAFFOLD_BRANCH_RE (Plan 22 F1)', () => {
    it.each([
        ['chore/scaffold'],                       // Team-Leader form — used to FAIL
        ['pacmanclaude/chore/scaffold'],          // dispatcher-prefixed form
        ['Chore/Scaffold'],                       // case-insensitive
        ['some/deep/prefix/chore/scaffold'],
    ])('matches %s', (name) => {
        expect(SCAFFOLD_BRANCH_RE.test(name)).toBe(true);
    });

    it.each([
        ['chore/scaffolding'],
        ['feature/us-015-app-bootstrap'],
        ['chore/scaffold/extra'],
        ['scaffold'],
    ])('does not match %s', (name) => {
        expect(SCAFFOLD_BRANCH_RE.test(name)).toBe(false);
    });
});

describe('isScaffoldAssignment', () => {
    it('matches an un-prefixed Team-Leader branch name', () => {
        expect(isScaffoldAssignment(assignment({ branchName: 'chore/scaffold', taskType: 'refactor' }))).toBe(true);
    });

    it('does not match a chore on a feature branch — taskType describes the work, not the branch (Plan 30-01)', () => {
        expect(isScaffoldAssignment(assignment({ branchName: 'feature/x', taskType: 'chore' }))).toBe(false);
    });

    it('does not match a chore without any branch name', () => {
        expect(isScaffoldAssignment(assignment({ branchName: undefined, taskType: 'chore' }))).toBe(false);
    });

    it('does not match an ordinary feature assignment', () => {
        expect(isScaffoldAssignment(assignment({ branchName: 'feature/us-002', taskType: 'feature' }))).toBe(false);
    });
});

describe('isScaffoldBranch', () => {
    it('classifies the exact pacmanclaude case as scaffold', () => {
        // 4 assignments on pacmanclaude/chore/scaffold, at least one taskType=refactor.
        const assignments = [
            assignment({ id: 'A1', taskType: 'chore', branchName: 'chore/scaffold' }),
            assignment({ id: 'A2', taskType: 'refactor', branchName: 'chore/scaffold' }),
            assignment({ id: 'A3', taskType: 'feature', branchName: 'chore/scaffold' }),
            assignment({ id: 'A4', taskType: 'refactor', branchName: 'chore/scaffold' }),
        ];
        expect(isScaffoldBranch('pacmanclaude/chore/scaffold')).toBe(true);
        expect(assignments.every(isScaffoldAssignment)).toBe(true);

        // Reproduce the old predicate to show why the barrier never fired:
        // the leading-slash requirement missed the un-prefixed Team-Leader name,
        // so `every()` fell through to taskType and any non-chore assignment
        // disqualified the whole branch.
        const OLD_RE = /\/chore\/scaffold$/i;
        const oldPredicate = (a: Assignment) => a.taskType === 'chore' || OLD_RE.test(a.branchName ?? '');
        expect(assignments.every(oldPredicate)).toBe(false);
        expect(OLD_RE.test('chore/scaffold')).toBe(false);
    });

    it('classifies by branch name alone', () => {
        expect(isScaffoldBranch('proj/chore/scaffold')).toBe(true);
    });

    it('does not classify a feature branch carrying a chore assignment as scaffold (Plan 30-01)', () => {
        expect(isScaffoldBranch('proj/feature/us-015')).toBe(false);

        const plan = buildDispatchPlan([
            assignment({ id: 'S1', branchName: 'chore/scaffold' }),
            assignment({ id: 'F1', storyId: 'US-015', taskType: 'chore', branchName: 'feature/us-015', description: 'Audit and compress assets' }),
        ], { projectSlug: 'proj' });
        expect(plan.branches.get('proj/feature/us-015')!.kind).toBe('feature');
        expect(plan.branches.get('proj/chore/scaffold')!.kind).toBe('scaffold');
        expect(plan.branchOrder).toEqual(['proj/chore/scaffold', 'proj/feature/us-015']);
    });

    it('does not classify a pure feature branch as scaffold', () => {
        expect(isScaffoldBranch('proj/feature/us-002')).toBe(false);
    });

    it('does not classify an empty branch name as scaffold', () => {
        expect(isScaffoldBranch('')).toBe(false);
    });
});

describe('scaffold barrier', () => {
    it('makes every feature assignment depend on an un-prefixed scaffold assignment', () => {
        const plan = buildDispatchPlan([
            assignment({ id: 'S1', taskType: 'refactor', branchName: 'chore/scaffold' }),
            assignment({ id: 'F1', storyId: 'US-002', taskType: 'feature', branchName: 'feature/us-002', dependsOn: [] }),
        ], { projectSlug: 'proj' });

        const feature = plan.branches.get('proj/feature/us-002')!;
        expect(feature.assignments[0].dependsOn).toContain('S1');
        expect(feature.dependsOnBranches).toEqual(['proj/chore/scaffold']);
        expect(plan.branches.get('proj/chore/scaffold')!.assignments[0].dependsOn).toEqual([]);
    });
});
