/**
 * Shared Bug construction helpers.
 *
 * Consolidates the 19+ inline Bug object-literal sites across conductor
 * modules into a single factory with consistent field ordering.
 */
import type { Bug } from '../agents/_shared/schemas/bug.schema';

type Severity = Bug['severity'];

interface BugOpts {
    failingTestId?: string;
    storyId?: string;
    suggestedAssignee?: string;
}

/**
 * Create a Bug with all required fields and optional extras.
 */
export function makeBug(
    id: string,
    title: string,
    severity: Severity,
    reportedBy: string,
    steps: {
        stepsToReproduce: string;
        expectedBehavior: string;
        actualBehavior: string;
        suspectedArea: string;
    },
    opts?: BugOpts,
): Bug {
    return {
        id,
        title,
        severity,
        reportedBy,
        ...steps,
        ...opts,
    };
}

/**
 * Shorthand for gate-synthesised bugs where the gate name is the reporter.
 */
export function makeGateBug(
    id: string,
    title: string,
    severity: Severity,
    gate: string,
    stepsToReproduce: string,
    expectedBehavior: string,
    actualBehavior: string,
    suspectedArea: string,
    opts?: BugOpts,
): Bug {
    return makeBug(id, title, severity, gate, {
        stepsToReproduce,
        expectedBehavior,
        actualBehavior,
        suspectedArea,
    }, opts);
}
