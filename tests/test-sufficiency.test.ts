/**
 * Test sufficiency gate tests — Sub-Plan 09.
 *
 * Verifies that checkTestSufficiency catches the exact patterns from pacman8 and retroboard3.
 */
import { checkTestSufficiency, sufficiencyViolationsToBugs } from '../src/conductor/test-sufficiency';
import type { ExecutedTestReport } from '../src/conductor/test-runners/executed-report';
import type { UserStory } from '../src/agents/_shared/schemas/user-story.schema';

// Mock config to control test behaviour
jest.mock('../src/config', () => ({
    QA_ENFORCE_SUFFICIENCY: true,
    QA_MIN_TOTAL_TESTS: 0,  // derived as max(5, storyCount)
    QA_MIN_TESTS_PER_STORY: 1,
    QA_MIN_COVERAGE_PCT: 40,
}));

function makeStory(id: string): UserStory {
    return {
        id,
        epicId: 'EPIC-001',
        asA: 'user',
        iWant: 'do something',
        soThat: 'get value',
        acceptanceCriteria: ['AC 1'],
    };
}

function makeReport(overrides: Partial<ExecutedTestReport> = {}): ExecutedTestReport {
    return {
        framework: 'jest',
        root: '',
        command: 'npm test',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        cases: [],
        exitCode: 0,
        runnerError: false,
        untracedTests: 0,
        untracedTestNames: [],
        ...overrides,
    };
}

// ─── pacman8 fixture ────────────────────────────────────────────────────────

describe('checkTestSufficiency — pacman8 scenario (0 tests, 20 stories)', () => {
    it('returns no-tests + below-min-tests violations', () => {
        const stories = Array.from({ length: 20 }, (_, i) => makeStory(`US-${String(i + 1).padStart(3, '0')}`));
        const executed = [makeReport()];

        const violations = checkTestSufficiency({
            executed,
            userStories: stories,
            trivialTestFiles: [],
            completedStoryIds: [],
        });

        expect(violations.some(v => v.kind === 'no-tests')).toBe(true);
        expect(violations.find(v => v.kind === 'no-tests')!.severity).toBe('critical');
    });
});

// ─── retroboard3 fixture ────────────────────────────────────────────────────

describe('checkTestSufficiency — retroboard3 scenario (1 trivial test, runner error, 13 stories)', () => {
    it('returns runner-error, all-tests-trivial, and 13 story-untested violations', () => {
        const stories = Array.from({ length: 13 }, (_, i) => makeStory(`US-${String(i + 1).padStart(3, '0')}`));

        const executed = [makeReport({
            total: 1,
            passed: 1,
            failed: 0,
            exitCode: 0,
            runnerError: false,
            cases: [{
                testName: 'adds 2 and 3',
                suite: 'math',
                file: '__tests__/math.test.js',
                status: 'pass' as const,
                durationMs: 5,
            }],
        })];

        const violations = checkTestSufficiency({
            executed,
            userStories: stories,
            trivialTestFiles: ['__tests__/math.test.js'],
            // every story had merged work in retroboard3
            completedStoryIds: stories.map(s => s.id),
        });

        expect(violations.some(v => v.kind === 'all-tests-trivial')).toBe(true);
        expect(violations.filter(v => v.kind === 'story-untested')).toHaveLength(13);
    });

    it('returns runner-error when runner fails to start', () => {
        const stories = Array.from({ length: 13 }, (_, i) => makeStory(`US-${String(i + 1).padStart(3, '0')}`));

        const executed = [makeReport({
            runnerError: true,
            exitCode: 1,
            runnerErrorDetail: "Cannot find module '@testing-library/jest-dom' from 'src/setupTests.ts'",
        })];

        const violations = checkTestSufficiency({
            executed,
            userStories: stories,
            trivialTestFiles: [],
            completedStoryIds: stories.map(s => s.id),
        });

        expect(violations.some(v => v.kind === 'runner-error')).toBe(true);
        expect(violations.find(v => v.kind === 'runner-error')!.severity).toBe('critical');
    });
});

// ─── Healthy fixture ────────────────────────────────────────────────────────

describe('checkTestSufficiency — healthy scenario', () => {
    it('returns zero violations when all checks pass', () => {
        const stories = [makeStory('US-001'), makeStory('US-002'), makeStory('US-003')];

        const cases = [
            // 3 stories with 3+ tests each
            ...['US-001', 'US-002', 'US-003'].flatMap(sid =>
                Array.from({ length: 3 }, (_, i) => ({
                    testName: `[${sid}#${i}] test case ${i}`,
                    suite: 'Suite',
                    file: 'tests/app.test.ts',
                    status: 'pass' as const,
                    durationMs: 10,
                    storyId: sid,
                    acIndex: i,
                }))
            ),
        ];

        const executed = [makeReport({
            total: 9,
            passed: 9,
            failed: 0,
            cases,
            coverage: { lines: 62, statements: 62, branches: 55, functions: 70 },
        })];

        const violations = checkTestSufficiency({
            executed,
            userStories: stories,
            trivialTestFiles: [],
            completedStoryIds: stories.map(s => s.id),
        });

        expect(violations).toHaveLength(0);
    });
});

// ─── Coverage below floor ───────────────────────────────────────────────────

describe('checkTestSufficiency — coverage below floor', () => {
    it('returns coverage-below-floor when line coverage is 35% with 40% floor', () => {
        const stories = [makeStory('US-001')];

        const executed = [makeReport({
            total: 5,
            passed: 5,
            cases: Array.from({ length: 5 }, (_, i) => ({
                testName: `[US-001#${i}] test ${i}`,
                suite: 'Suite',
                file: 'test.ts',
                status: 'pass' as const,
                durationMs: 10,
                storyId: 'US-001',
                acIndex: i,
            })),
            coverage: { lines: 35, statements: 35, branches: 20, functions: 40 },
        })];

        const violations = checkTestSufficiency({
            executed,
            userStories: stories,
            trivialTestFiles: [],
            completedStoryIds: ['US-001'],
        });

        expect(violations.some(v => v.kind === 'coverage-below-floor')).toBe(true);
        expect(violations.find(v => v.kind === 'coverage-below-floor')!.severity).toBe('major');
    });
});

// ─── Plan 30-03: no derived false bugs ──────────────────────────────────────

describe('checkTestSufficiency — claudeopus5 QA round (Plan 30-03)', () => {
    // 35 stories, two roots whose runner failed: 36 bugs before (1 runner-error + 35 story-untested).
    const stories = Array.from({ length: 35 }, (_, i) => makeStory(`US-${String(i + 1).padStart(3, '0')}`));
    const failedRoots = [
        makeReport({
            framework: 'karma', command: 'npm test -- --watch=false', exitCode: 127, runnerError: true,
            runnerErrorDetail: 'command not found: ng — dependencies not installed?\nsh: 1: ng: not found',
        }),
        makeReport({
            root: 'packages/web', framework: 'karma', command: 'npm test -- --watch=false', exitCode: 1, runnerError: true,
            runnerErrorDetail: '`npm test -- --watch=false` exited 1 without a failing spec\nError: Unknown arguments: ci, json',
        }),
    ];

    it('a runner error produces exactly one bug, carrying each command and its rendered output', () => {
        const violations = checkTestSufficiency({
            executed: failedRoots, userStories: stories, trivialTestFiles: [], completedStoryIds: ['US-001', 'US-002'],
        });

        expect(violations.map(v => v.kind)).toEqual(['runner-error']);
        const bugs = sufficiencyViolationsToBugs(violations);
        expect(bugs).toHaveLength(1);
        expect(bugs[0].id).toBe('QA-runner-error');
        expect(bugs[0].stepsToReproduce).toBe('Run `npm test -- --watch=false` in .\nRun `npm test -- --watch=false` in packages/web');
        expect(bugs[0].actualBehavior).toContain('Root ".": `npm test -- --watch=false` (exit 127)\ncommand not found: ng');
        expect(bugs[0].actualBehavior).toContain('Root "packages/web": `npm test -- --watch=false` (exit 1)');
        expect(bugs[0].actualBehavior).toContain('Error: Unknown arguments: ci, json');
    });

    it('story-untested applies only to stories with merged work', () => {
        const executed = [makeReport({
            total: 6, passed: 6,
            cases: Array.from({ length: 6 }, (_, i) => ({
                testName: `[US-001#${i}] test ${i}`, suite: 'Suite', file: `t${i}.spec.ts`, status: 'pass' as const,
                durationMs: 1, storyId: 'US-001', acIndex: i,
            })),
        })];
        const violations = checkTestSufficiency({
            executed, userStories: stories.slice(0, 5), trivialTestFiles: [], completedStoryIds: ['US-001', 'US-002'],
        });

        expect(violations.filter(v => v.kind === 'story-untested')).toEqual([
            expect.objectContaining({ storyId: 'US-002', severity: 'critical' }),
        ]);
    });

    it('skips the min-test and per-story checks when no root produced case names', () => {
        const executed = [makeReport({
            framework: 'karma', total: 134, passed: 133, failed: 1, exitCode: 1, caseNames: 'unavailable',
            cases: [{ testName: 'Score > [US-027#1] truncates', suite: 'Score', file: '', status: 'fail', durationMs: 0, storyId: 'US-027', acIndex: 1 }],
        })];
        const violations = checkTestSufficiency({
            executed, userStories: stories, trivialTestFiles: [], completedStoryIds: stories.map(s => s.id),
        });

        expect(violations).toEqual([]);
    });

    it('an unknown runner that exited 0 is unmeasured, not "no tests"', () => {
        const executed = [makeReport({ framework: 'unknown', exitCode: 0, caseNames: 'unavailable', runnerErrorDetail: 'exit 0; this runner has no machine-readable report' })];
        expect(checkTestSufficiency({ executed, userStories: stories, trivialTestFiles: [], completedStoryIds: [] })).toEqual([]);
    });
});

// ─── sufficiencyViolationsToBugs ────────────────────────────────────────────

describe('sufficiencyViolationsToBugs', () => {
    it('converts violations to bugs with stable ids', () => {
        const violations = [
            { kind: 'no-tests' as const, severity: 'critical' as const, detail: 'No tests found' },
            { kind: 'story-untested' as const, severity: 'major' as const, detail: 'Story US-001 has 0 tests', storyId: 'US-001' },
        ];

        const bugs = sufficiencyViolationsToBugs(violations);

        expect(bugs).toHaveLength(2);
        expect(bugs[0].id).toBe('QA-no-tests');
        expect(bugs[0].severity).toBe('critical');
        expect(bugs[1].id).toBe('QA-story-untested-US-001');
        expect(bugs[1].severity).toBe('major');
    });
});
