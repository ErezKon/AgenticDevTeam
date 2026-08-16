/**
 * Scaffold branch classification (Plan 22, F1).
 *
 * ## The bug these tests pin
 *
 * `isScaffoldAssignment` matched `/\/chore\/scaffold$/i`, which requires a leading
 * slash. The Team Leader emits un-prefixed branch names (`chore/scaffold`); the
 * dispatcher adds the `<project>/` prefix later. And `scaffoldBranches` required
 * `every` assignment on the branch to look like scaffold work, so one
 * `refactor`-typed assignment sharing the branch disabled the barrier entirely.
 *
 * Net effect in the pacmanclaude run: no `Scaffold barrier:` line in the log at
 * all — the scaffold was dispatched as an ordinary serialised feature branch, so
 * feature worktrees were not guaranteed to be cut from a merged scaffold.
 */
import {
    SCAFFOLD_BRANCH_RE, isScaffoldAssignment, isScaffoldBranch, injectScaffoldDependencies,
} from '../src/agents/developers/dispatcher';
import type { Assignment } from '../src/agents/_shared/base-schemas';

function assignment(over: Partial<Assignment> = {}): Assignment {
    return {
        id: 'ASSIGN-001',
        taskId: 'TASK-001',
        storyId: 'US-014',
        devAgentId: 'principal-frontend',
        description: 'Scaffold the Vite PWA',
        taskType: 'chore',
        branchName: 'chore/scaffold',
        reviewers: [],
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

    it('matches on taskType chore regardless of branch name', () => {
        expect(isScaffoldAssignment(assignment({ branchName: 'feature/x', taskType: 'chore' }))).toBe(true);
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
        expect(isScaffoldBranch('pacmanclaude/chore/scaffold', assignments)).toBe(true);

        // Reproduce the old predicate to show why the barrier never fired:
        // the leading-slash requirement missed the un-prefixed Team-Leader name,
        // so `every()` fell through to taskType and any non-chore assignment
        // disqualified the whole branch.
        const OLD_RE = /\/chore\/scaffold$/i;
        const oldPredicate = (a: Assignment) => a.taskType === 'chore' || OLD_RE.test(a.branchName ?? '');
        expect(assignments.every(oldPredicate)).toBe(false);
        expect(OLD_RE.test('chore/scaffold')).toBe(false);
    });

    it('classifies by branch name even with no assignment metadata', () => {
        expect(isScaffoldBranch('proj/chore/scaffold', [])).toBe(true);
    });

    it('classifies a feature branch carrying a chore assignment as scaffold', () => {
        expect(isScaffoldBranch('proj/feature/us-015', [assignment({ taskType: 'chore', branchName: 'feature/us-015' })]))
            .toBe(true);
    });

    it('does not classify a pure feature branch as scaffold', () => {
        const assignments = [assignment({ taskType: 'feature', branchName: 'feature/us-002' })];
        expect(isScaffoldBranch('proj/feature/us-002', assignments)).toBe(false);
    });

    it('does not classify an empty non-scaffold branch as scaffold', () => {
        expect(isScaffoldBranch('proj/feature/us-002', [])).toBe(false);
    });
});

describe('injectScaffoldDependencies', () => {
    it('makes every feature assignment depend on an un-prefixed scaffold assignment', () => {
        const assignments = [
            assignment({ id: 'S1', taskType: 'refactor', branchName: 'chore/scaffold' }),
            assignment({ id: 'F1', taskType: 'feature', branchName: 'feature/us-002', dependsOn: [] }),
        ];

        const out = injectScaffoldDependencies(assignments);

        expect(out.find(a => a.id === 'F1')!.dependsOn).toContain('S1');
        expect(out.find(a => a.id === 'S1')!.dependsOn).toEqual([]);
    });
});
