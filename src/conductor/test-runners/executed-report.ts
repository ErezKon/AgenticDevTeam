/**
 * The executed-test-report model shared by the runner adapters (Plan 30-03).
 *
 * `test-runner.ts` executes the suites and owns the Jest/JUnit/Go/TRX parsers;
 * `karma.ts` builds and parses Karma runs. Both produce `ExecutedTestReport`s
 * from the types and helpers here, so neither imports the other.
 */

/** A `[US-003#1]` / `[US-003#-1]` traceability tag. */
const TAG_SOURCE = String.raw`\[([A-Za-z]+-\d+)#(-?\d+)\]`;
const TAG_AT_START_RE = new RegExp(`^${TAG_SOURCE}\\s*`);
const TAG_ANYWHERE_RE = new RegExp(TAG_SOURCE);

export interface ExecutedTestCase {
    testName: string;
    suite: string;
    file: string;
    status: 'pass' | 'fail' | 'skip';
    durationMs: number;
    error?: string;
    /** Parsed from the test name annotation `[US-003#1]`, when present. */
    storyId?: string;
    acIndex?: number;
}

export interface ExecutedTestReport {
    framework: string;
    root: string;
    /** The exact command that ran (the install command when installing failed; '' when nothing ran). */
    command: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    cases: ExecutedTestCase[];
    coverage?: { lines: number; statements: number; branches: number; functions: number };
    /** Raw runner exit code. */
    exitCode: number;
    /** True when the runner itself failed to start (config error, missing dep). */
    runnerError: boolean;
    /** Why the runner produced no usable result, with the rendered output summary for runner errors. */
    runnerErrorDetail?: string;
    /** Count of tests that lack a traceability tag. */
    untracedTests: number;
    /** First 10 untraced test names. */
    untracedTestNames: string[];
    /**
     * `'unavailable'` when the result comes from the rendered output instead of a
     * machine-readable report (Karma without its JSON reporter, a runner we cannot
     * ask for one): `cases` lists at most the failed specs, so per-story and AC
     * checks cannot use this report.
     */
    caseNames?: 'unavailable';
}

/** A parsed runner result, before the command and its exit status are attached. */
export type ParsedRun = Omit<ExecutedTestReport, 'command' | 'exitCode' | 'runnerError' | 'runnerErrorDetail' | 'coverage'>;

/** Extract `[US-003#1]` from the start of a test name, returning storyId/acIndex or null. */
export function parseTraceTag(name: string): { storyId: string; acIndex: number } | null {
    const m = TAG_AT_START_RE.exec(name);
    if (!m) return null;
    return { storyId: m[1], acIndex: parseInt(m[2], 10) };
}

/** Where a traceability tag starts inside a longer name (Karma prints `<suite> <description>` on one line), or -1. */
export function traceTagIndex(text: string): number {
    return text.search(TAG_ANYWHERE_RE);
}

/** Counts and the untraced-test summary for a list of parsed cases. */
export function tallyCases(framework: string, root: string, cases: ExecutedTestCase[]): ParsedRun {
    const untraced = cases.filter(c => !c.storyId && c.status !== 'skip');
    return {
        framework,
        root,
        total: cases.length,
        passed: cases.filter(c => c.status === 'pass').length,
        failed: cases.filter(c => c.status === 'fail').length,
        skipped: cases.filter(c => c.status === 'skip').length,
        cases,
        untracedTests: untraced.length,
        untracedTestNames: untraced.slice(0, 10).map(c => c.testName),
    };
}
