/**
 * Test runner parser tests — the highest-value tests in Sub-Plan 09.
 *
 * Uses real runner output fixtures to verify correct parsing of:
 * - Jest JSON output (passing, failing, runner error, no tests)
 * - JUnit XML (pytest, surefire)
 * - Go test JSON
 * - Coverage summary
 * - Traceability tag parsing
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    parseJestJson,
    parseJunitXml,
    parseGoTestJson,
    parseCoverageSummary,
    parseTraceTag,
    isRunnerError,
    executedToTestReports,
    compareClaimVsReality,
} from '../src/conductor/test-runner';

const FIXTURES = path.join(__dirname, 'fixtures', 'test-reports');

// ─── Tag parsing ────────────────────────────────────────────────────────────

describe('parseTraceTag', () => {
    it('parses [US-003#1] tag', () => {
        const result = parseTraceTag('[US-003#1] eating a dot removes it');
        expect(result).toEqual({ storyId: 'US-003', acIndex: 1 });
    });

    it('parses [US-003#-1] whole-story tag', () => {
        const result = parseTraceTag('[US-003#-1] the maze renders without errors');
        expect(result).toEqual({ storyId: 'US-003', acIndex: -1 });
    });

    it('parses [US-003#0] zero-indexed tag', () => {
        const result = parseTraceTag('[US-003#0] initializes with default state');
        expect(result).toEqual({ storyId: 'US-003', acIndex: 0 });
    });

    it('returns null for untagged names', () => {
        expect(parseTraceTag('should handle edge cases')).toBeNull();
    });

    it('returns null for malformed tags', () => {
        expect(parseTraceTag('[US003] missing dash')).toBeNull();
        expect(parseTraceTag('[US-003] missing hash')).toBeNull();
    });
});

// ─── Jest JSON parsing ──────────────────────────────────────────────────────

describe('parseJestJson', () => {
    it('correctly parses a mixed-result Jest output with 12 passing, 3 failing, 1 skipped', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'jest-passing.json'), 'utf-8');
        const result = parseJestJson(raw, '/tmp/project');

        expect(result.framework).toBe('jest');
        expect(result.total).toBe(16);
        expect(result.passed).toBe(12);
        expect(result.failed).toBe(3);
        expect(result.skipped).toBe(1);
    });

    it('extracts per-case data with correct statuses', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'jest-passing.json'), 'utf-8');
        const result = parseJestJson(raw, '/tmp/project');

        // Check a passing test
        const passing = result.cases.find(c => c.testName.includes('initializes with default state'));
        expect(passing).toBeDefined();
        expect(passing!.status).toBe('pass');
        expect(passing!.durationMs).toBe(12);

        // Check a failing test
        const failing = result.cases.find(c => c.testName.includes('handles touch input'));
        expect(failing).toBeDefined();
        expect(failing!.status).toBe('fail');
        expect(failing!.error).toContain('Touch events not supported');
    });

    it('extracts traceability tags from test names', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'jest-passing.json'), 'utf-8');
        const result = parseJestJson(raw, '/tmp/project');

        const tagged = result.cases.find(c => c.testName.includes('[US-001#0]'));
        expect(tagged).toBeDefined();
        expect(tagged!.storyId).toBe('US-001');
        expect(tagged!.acIndex).toBe(0);

        const wholeStory = result.cases.find(c => c.testName.includes('[US-003#-1]'));
        expect(wholeStory).toBeDefined();
        expect(wholeStory!.storyId).toBe('US-003');
        expect(wholeStory!.acIndex).toBe(-1);
    });

    it('counts untraced tests correctly', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'jest-passing.json'), 'utf-8');
        const result = parseJestJson(raw, '/tmp/project');

        // "untagged test for internal logic" and "handles edge case input" are untagged non-skip
        expect(result.untracedTests).toBe(2);
        expect(result.untracedTestNames).toContain('Game Engine > untagged test for internal logic');
    });

    it('handles a suite-level runner failure (Cannot find module)', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'jest-runner-error.json'), 'utf-8');
        const result = parseJestJson(raw, '/tmp/project');

        // Jest reports numTotalTests=0, numFailedTests=0 for suite-level failures
        // The fixture mirrors this — the failure appears as a "test" entry but
        // Jest counts it as numTotalTests=0.
        expect(result.total).toBe(0);
        expect(result.passed).toBe(0);
        expect(result.failed).toBe(0);
        // But there IS a case entry with status=fail (the suite-level crash)
        expect(result.cases.length).toBe(1);
        expect(result.cases[0].status).toBe('fail');
        expect(result.cases[0].error).toContain('Cannot find module');
    });

    it('handles "No tests found" output correctly', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'jest-no-tests.json'), 'utf-8');
        const result = parseJestJson(raw, '/tmp/project');

        expect(result.total).toBe(0);
        expect(result.passed).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.cases).toHaveLength(0);
    });
});

// ─── JUnit XML parsing ──────────────────────────────────────────────────────

describe('parseJunitXml', () => {
    it('parses pytest JUnit XML with correct counts', () => {
        const xml = fs.readFileSync(path.join(FIXTURES, 'junit-pytest.xml'), 'utf-8');
        const result = parseJunitXml(xml, '/tmp/project', 'pytest');

        expect(result.framework).toBe('pytest');
        expect(result.total).toBe(5);
        expect(result.passed).toBe(3);
        expect(result.failed).toBe(1);
        expect(result.skipped).toBe(1);
    });

    it('extracts traceability tags from JUnit test names', () => {
        const xml = fs.readFileSync(path.join(FIXTURES, 'junit-pytest.xml'), 'utf-8');
        const result = parseJunitXml(xml, '/tmp/project', 'pytest');

        const tagged = result.cases.find(c => c.testName.includes('[US-010#0]'));
        expect(tagged).toBeDefined();
        expect(tagged!.storyId).toBe('US-010');
        expect(tagged!.acIndex).toBe(0);
    });

    it('extracts failure messages from JUnit XML', () => {
        const xml = fs.readFileSync(path.join(FIXTURES, 'junit-pytest.xml'), 'utf-8');
        const result = parseJunitXml(xml, '/tmp/project', 'pytest');

        const failing = result.cases.find(c => c.status === 'fail');
        expect(failing).toBeDefined();
        expect(failing!.error).toContain('Expected 200 but got 404');
    });

    it('detects skipped tests', () => {
        const xml = fs.readFileSync(path.join(FIXTURES, 'junit-pytest.xml'), 'utf-8');
        const result = parseJunitXml(xml, '/tmp/project', 'pytest');

        const skipped = result.cases.find(c => c.status === 'skip');
        expect(skipped).toBeDefined();
        expect(skipped!.testName).toBe('test_refresh_token');
    });

    it('skipped tests do not count as untraced', () => {
        const xml = fs.readFileSync(path.join(FIXTURES, 'junit-pytest.xml'), 'utf-8');
        const result = parseJunitXml(xml, '/tmp/project', 'pytest');

        // test_refresh_token is skipped, so it doesn't count as untraced.
        // All non-skip tests have tags, so untracedTests should be 0.
        expect(result.untracedTests).toBe(0);
    });
});

// ─── Go test JSON parsing ───────────────────────────────────────────────────

describe('parseGoTestJson', () => {
    it('parses Go test JSON events with correct counts', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'go-test.jsonl'), 'utf-8');
        const result = parseGoTestJson(raw, '/tmp/project');

        expect(result.framework).toBe('go');
        expect(result.total).toBe(4);
        expect(result.passed).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.skipped).toBe(1);
    });

    it('extracts traceability tags from Go test names', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'go-test.jsonl'), 'utf-8');
        const result = parseGoTestJson(raw, '/tmp/project');

        const tagged = result.cases.find(c => c.testName.includes('[US-020#0]'));
        expect(tagged).toBeDefined();
        expect(tagged!.storyId).toBe('US-020');
        expect(tagged!.acIndex).toBe(0);
    });

    it('captures failure output for failed tests', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'go-test.jsonl'), 'utf-8');
        const result = parseGoTestJson(raw, '/tmp/project');

        const failing = result.cases.find(c => c.status === 'fail');
        expect(failing).toBeDefined();
        expect(failing!.error).toContain('expected status 200, got 500');
    });

    it('counts untraced tests (TestHelperFunc has no tag)', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'go-test.jsonl'), 'utf-8');
        const result = parseGoTestJson(raw, '/tmp/project');

        expect(result.untracedTests).toBe(1);
        expect(result.untracedTestNames).toContain('TestHelperFunc');
    });
});

// ─── Coverage parsing ───────────────────────────────────────────────────────

describe('parseCoverageSummary', () => {
    it('parses Jest coverage-summary.json', () => {
        const raw = fs.readFileSync(path.join(FIXTURES, 'coverage-summary.json'), 'utf-8');
        const result = parseCoverageSummary(raw);

        expect(result).toBeDefined();
        expect(result!.lines).toBe(62);
        expect(result!.statements).toBe(62);
        expect(result!.branches).toBe(55);
        expect(result!.functions).toBe(70);
    });

    it('returns undefined for invalid JSON', () => {
        expect(parseCoverageSummary('not json')).toBeUndefined();
    });

    it('returns undefined for JSON without total', () => {
        expect(parseCoverageSummary('{}')).toBeUndefined();
    });
});

// ─── Runner error detection ─────────────────────────────────────────────────

describe('isRunnerError', () => {
    it('detects Cannot find module', () => {
        expect(isRunnerError("Cannot find module '@testing-library/jest-dom' from 'src/setupTests.ts'")).toBe(true);
    });

    it('detects SyntaxError', () => {
        expect(isRunnerError('SyntaxError: Unexpected token')).toBe(true);
    });

    it('detects "Your test suite must contain at least one test"', () => {
        expect(isRunnerError('Your test suite must contain at least one test')).toBe(true);
    });

    it('does not flag normal test failure output', () => {
        expect(isRunnerError('FAIL src/__tests__/game.test.ts\n  Game Engine\n    x handles edge case')).toBe(false);
    });
});

// ─── executedToTestReports ──────────────────────────────────────────────────

describe('executedToTestReports', () => {
    it('converts executed reports to TestReport format with source=executed', () => {
        const reports = executedToTestReports([{
            framework: 'jest',
            root: '',
            total: 5,
            passed: 4,
            failed: 1,
            skipped: 0,
            cases: [
                { testName: '[US-001#0] test1', suite: 'Suite', file: 'test.ts', status: 'pass' as const, durationMs: 10, storyId: 'US-001', acIndex: 0 },
                { testName: '[US-001#1] test2', suite: 'Suite', file: 'test.ts', status: 'pass' as const, durationMs: 10, storyId: 'US-001', acIndex: 1 },
                { testName: '[US-002#0] test3', suite: 'Suite', file: 'test.ts', status: 'pass' as const, durationMs: 10, storyId: 'US-002', acIndex: 0 },
                { testName: 'untagged test4', suite: 'Suite', file: 'test.ts', status: 'pass' as const, durationMs: 10 },
                { testName: '[US-002#1] test5', suite: 'Suite', file: 'test.ts', status: 'fail' as const, durationMs: 10, error: 'oops', storyId: 'US-002', acIndex: 1 },
            ],
            exitCode: 1,
            runnerError: false,
            untracedTests: 1,
            untracedTestNames: ['untagged test4'],
        }]);

        expect(reports).toHaveLength(1);
        const r = reports[0];
        expect(r.source).toBe('executed');
        expect(r.status).toBe('fail');
        expect(r.total).toBe(5);
        expect(r.passed).toBe(4);
        expect(r.failed).toBe(1);
        expect(r.cases).toHaveLength(5);
        expect(r.failures).toHaveLength(1);
        expect(r.failures[0].testName).toBe('[US-002#1] test5');
    });

    it('marks runner errors as inconclusive', () => {
        const reports = executedToTestReports([{
            framework: 'jest',
            root: '',
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            cases: [],
            exitCode: 1,
            runnerError: true,
            runnerErrorDetail: 'Cannot find module',
            untracedTests: 0,
            untracedTestNames: [],
        }]);

        expect(reports[0].status).toBe('inconclusive');
        expect(reports[0].runnerError).toBe(true);
    });

    it('marks zero-test reports as inconclusive', () => {
        const reports = executedToTestReports([{
            framework: 'jest',
            root: '',
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            cases: [],
            exitCode: 1,
            runnerError: false,
            untracedTests: 0,
            untracedTestNames: [],
        }]);

        expect(reports[0].status).toBe('inconclusive');
    });
});

// ─── Claim vs Reality ───────────────────────────────────────────────────────

describe('compareClaimVsReality', () => {
    const mockLogger = { warn: jest.fn() };

    beforeEach(() => mockLogger.warn.mockClear());

    it('detects when QA claims 12 passed but runner found 0', () => {
        const claimed = {
            type: 'unit' as const,
            framework: 'jest',
            total: 12,
            passed: 12,
            failed: 0,
            skipped: 0,
            status: 'pass' as const,
            source: 'claimed' as const,
            iterationIndex: 0,
            runnerError: false,
            failures: [],
            agentId: 'qa-unit',
            cases: [],
        };

        const executed = [{
            type: 'unit' as const,
            framework: 'jest',
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            status: 'inconclusive' as const,
            source: 'executed' as const,
            iterationIndex: 0,
            runnerError: false,
            failures: [],
            agentId: 'test-runner',
            cases: [],
        }];

        const discs = compareClaimVsReality(claimed, executed, mockLogger);
        expect(discs.length).toBeGreaterThan(0);
        expect(discs.find(d => d.field === 'total')).toBeDefined();
        expect(discs.find(d => d.field === 'status')).toBeDefined();
        expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('reports no discrepancies when claim matches reality', () => {
        const claimed = {
            type: 'unit' as const,
            framework: 'jest',
            total: 5,
            passed: 4,
            failed: 1,
            skipped: 0,
            status: 'fail' as const,
            source: 'claimed' as const,
            iterationIndex: 0,
            runnerError: false,
            failures: [{ testName: 'test', error: 'err' }],
            agentId: 'qa-unit',
            cases: [],
        };

        const executed = [{
            type: 'unit' as const,
            framework: 'jest',
            total: 5,
            passed: 4,
            failed: 1,
            skipped: 0,
            status: 'fail' as const,
            source: 'executed' as const,
            iterationIndex: 0,
            runnerError: false,
            failures: [{ testName: 'test', error: 'err' }],
            agentId: 'test-runner',
            cases: [],
        }];

        const discs = compareClaimVsReality(claimed, executed, mockLogger);
        expect(discs).toHaveLength(0);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });
});
