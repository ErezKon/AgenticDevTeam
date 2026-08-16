/**
 * Test sufficiency gates — minimum test counts, coverage floor, per-story coverage.
 *
 * Sub-Plan 09: prevents "0 tests found = pass" and ensures every story has
 * at least one tagged test.
 */
import { getLogger } from '../utils/logger';
import type { ExecutedTestReport } from './test-runner';
import type { UserStory } from '../agents/_shared/schemas/user-story.schema';
import type { Bug } from '../agents/_shared/schemas/bug.schema';
import {
    QA_ENFORCE_SUFFICIENCY,
    QA_MIN_TOTAL_TESTS,
    QA_MIN_TESTS_PER_STORY,
    QA_MIN_COVERAGE_PCT,
} from '../config';

const log = getLogger('[TestSufficiency]', 205);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SufficiencyViolation {
    kind: 'no-tests' | 'runner-error' | 'below-min-tests' | 'below-min-per-story'
        | 'coverage-below-floor' | 'all-tests-trivial' | 'story-untested';
    severity: 'critical' | 'major';
    detail: string;
    /** For story-level violations, the story id. */
    storyId?: string;
}

// ─── Sufficiency check ──────────────────────────────────────────────────────

/**
 * Check that executed test results meet minimum quality thresholds.
 *
 * Returns an array of violations (empty = all checks passed).
 */
export function checkTestSufficiency(input: {
    executed: ExecutedTestReport[];
    userStories: UserStory[];
    trivialTestFiles: string[];
    /** Assignment ids per story that were merged/completed. */
    completedStoryIds?: string[];
}): SufficiencyViolation[] {
    if (!QA_ENFORCE_SUFFICIENCY) return [];

    const { executed, userStories, trivialTestFiles, completedStoryIds } = input;
    const violations: SufficiencyViolation[] = [];
    const completedSet = new Set(completedStoryIds ?? []);

    // ── Check 1: at least one root executed tests ────────────────────────
    const rootsWithTests = executed.filter(e => !e.runnerError && e.total > 0);
    if (rootsWithTests.length === 0) {
        const hasRunnerError = executed.some(e => e.runnerError);
        if (hasRunnerError) {
            const errs = executed.filter(e => e.runnerError);
            violations.push({
                kind: 'runner-error',
                severity: 'critical',
                detail: `Test runner failed in ${errs.length} root(s): ${errs.map(e => e.runnerErrorDetail?.slice(0, 200) || 'unknown').join('; ')}`,
            });
        } else {
            violations.push({
                kind: 'no-tests',
                severity: 'critical',
                detail: `No tests were found or executed across ${executed.length} stack root(s).`,
            });
        }
    }

    // ── Check 2: no runner errors ────────────────────────────────────────
    for (const e of executed) {
        if (e.runnerError && rootsWithTests.length > 0) {
            // Only add if we didn't already catch it above (all-roots-failing)
            violations.push({
                kind: 'runner-error',
                severity: 'critical',
                detail: `Test runner error in root "${e.root || '.'}": ${e.runnerErrorDetail?.slice(0, 200) || 'unknown'}`,
            });
        }
    }

    // ── Check 3: total non-trivial tests >= threshold ────────────────────
    const allCases = executed.flatMap(e => e.cases);
    const trivialSet = new Set(trivialTestFiles);
    const nonTrivialCases = allCases.filter(c => !trivialSet.has(c.file));
    const minTests = QA_MIN_TOTAL_TESTS > 0
        ? QA_MIN_TOTAL_TESTS
        : Math.max(5, userStories.length);

    if (nonTrivialCases.length < minTests && rootsWithTests.length > 0) {
        violations.push({
            kind: 'below-min-tests',
            severity: 'critical',
            detail: `Only ${nonTrivialCases.length} non-trivial test(s) executed; minimum is ${minTests} (max(5, storyCount=${userStories.length})).`,
        });
    }

    // ── Check 4: each story has >= min tagged passing tests ──────────────
    if (QA_MIN_TESTS_PER_STORY > 0 && userStories.length > 0) {
        const taggedPassingByStory = new Map<string, number>();
        for (const c of allCases) {
            if (c.status === 'pass' && c.storyId) {
                taggedPassingByStory.set(c.storyId, (taggedPassingByStory.get(c.storyId) || 0) + 1);
            }
        }

        for (const story of userStories) {
            const count = taggedPassingByStory.get(story.id) || 0;
            if (count < QA_MIN_TESTS_PER_STORY) {
                const isCompleted = completedSet.has(story.id);
                violations.push({
                    kind: 'story-untested',
                    severity: isCompleted ? 'critical' : 'major',
                    detail: `Story ${story.id} has ${count} tagged passing test(s); minimum is ${QA_MIN_TESTS_PER_STORY}.`,
                    storyId: story.id,
                });
            }
        }
    }

    // ── Check 5: line coverage >= floor ──────────────────────────────────
    if (QA_MIN_COVERAGE_PCT > 0) {
        const coverageReports = executed.filter(e => e.coverage);
        if (coverageReports.length > 0) {
            // Use the average across roots
            const avgLines = coverageReports.reduce((sum, e) => sum + (e.coverage?.lines ?? 0), 0) / coverageReports.length;
            if (avgLines < QA_MIN_COVERAGE_PCT) {
                violations.push({
                    kind: 'coverage-below-floor',
                    severity: 'major',
                    detail: `Line coverage ${avgLines.toFixed(1)}% is below the ${QA_MIN_COVERAGE_PCT}% floor.`,
                });
            }
        }
    }

    // ── Check 6: not every test file is trivial ──────────────────────────
    if (trivialTestFiles.length > 0) {
        const testFiles = new Set(allCases.map(c => c.file));
        const nonTrivialFiles = [...testFiles].filter(f => !trivialSet.has(f));
        if (testFiles.size > 0 && nonTrivialFiles.length === 0) {
            violations.push({
                kind: 'all-tests-trivial',
                severity: 'critical',
                detail: `All ${testFiles.size} test file(s) are trivial (no product imports). Tests must exercise real product code.`,
            });
        }
    }

    return violations;
}

// ─── Violations → Bugs ──────────────────────────────────────────────────────

/**
 * Convert sufficiency violations into Bugs with stable ids `QA-<kind>[-<storyId>]`.
 */
export function sufficiencyViolationsToBugs(violations: SufficiencyViolation[]): Bug[] {
    return violations.map(v => ({
        id: v.storyId ? `QA-${v.kind}-${v.storyId}` : `QA-${v.kind}`,
        title: `Test sufficiency: ${v.kind}${v.storyId ? ` (${v.storyId})` : ''}`,
        severity: v.severity,
        stepsToReproduce: v.detail,
        expectedBehavior: getExpectedBehavior(v.kind),
        actualBehavior: v.detail,
        // Carry the real story id as structured data. It used to live only in
        // `suspectedArea` prose, so triage copied the synthetic BUG id into
        // `assignment.storyId` and developers lost their acceptance criteria
        // (Plan 21, E5).
        ...(v.storyId && { storyId: v.storyId }),
        suspectedArea: v.storyId ? `Story ${v.storyId}` : 'Test suite',
        reportedBy: 'test-sufficiency',
    }));
}

function getExpectedBehavior(kind: SufficiencyViolation['kind']): string {
    switch (kind) {
        case 'no-tests': return 'At least one test suite should execute successfully.';
        case 'runner-error': return 'The test runner should start without configuration errors.';
        case 'below-min-tests': return 'The total non-trivial test count should meet the minimum threshold.';
        case 'below-min-per-story': return 'Each story should have at least the minimum number of tagged passing tests.';
        case 'coverage-below-floor': return 'Line coverage should meet the configured floor.';
        case 'all-tests-trivial': return 'At least one test file should import and test real product code.';
        case 'story-untested': return 'The story should have tagged passing tests verifying its acceptance criteria.';
    }
}

// ─── Sufficiency report markdown ────────────────────────────────────────────

/**
 * Render sufficiency violations as a markdown summary.
 */
export function sufficiencyToMarkdown(violations: SufficiencyViolation[]): string {
    if (violations.length === 0) {
        return ':white_check_mark: **Test sufficiency: all checks passed.**';
    }

    const lines: string[] = [':x: **Test sufficiency violations:**\n'];
    const critical = violations.filter(v => v.severity === 'critical');
    const major = violations.filter(v => v.severity === 'major');

    if (critical.length > 0) {
        lines.push(`**Critical (${critical.length}):**`);
        for (const v of critical) {
            lines.push(`- \`${v.kind}\`: ${v.detail}`);
        }
    }
    if (major.length > 0) {
        lines.push(`\n**Major (${major.length}):**`);
        for (const v of major) {
            lines.push(`- \`${v.kind}\`: ${v.detail}`);
        }
    }

    return lines.join('\n');
}
