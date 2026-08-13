/**
 * Test sufficiency gate tests — Sub-Plan 09.
 *
 * Verifies that checkTestSufficiency catches the exact patterns from pacman8 and retroboard3.
 */
import { checkTestSufficiency, sufficiencyViolationsToBugs } from '../src/conductor/test-sufficiency';
import type { ExecutedTestReport } from '../src/conductor/test-runner';
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
        });

        expect(violations.some(v => v.kind === 'coverage-below-floor')).toBe(true);
        expect(violations.find(v => v.kind === 'coverage-below-floor')!.severity).toBe('major');
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
