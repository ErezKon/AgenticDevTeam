/**
 * Acceptance gate node — evaluates acceptance criteria, writes the
 * acceptance report, and converts blockers to bugs for the bugfix loop.
 */
import { getLogger } from '../../utils/logger';
import { writeArtifact } from '../../agents/_shared/artifact';
import { writeOutputFile } from '../../utils/artifact-writer';
import { evaluateAcceptance, acceptanceReportToMarkdown, acceptanceBlockersToBugs } from '../acceptance-gate';
import { emitRunEvent } from '../../utils/event-bus';
import { writePeriodicSnapshot } from '../../utils/run-snapshot';
import { shouldSkipOnContinue, msg } from './_guards';
import type { ProjectStateType } from '../state';
import type { PhaseName, TranscriptMessage } from '../../agents/_shared/base-schemas';

const acceptLog = getLogger('[Acceptance]', 214);

export async function acceptanceNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Continue-run idempotency: skip only if resume target is past acceptance-gate
    if (shouldSkipOnContinue(state, 'acceptance-gate', acceptLog)) {
        return { phase: 'acceptance-gate' as PhaseName };
    }
    emitRunEvent('phase:start', { phase: 'acceptance-gate' });
    writePeriodicSnapshot(state.outputPath, state, 'acceptance-gate');
    // No budget check here — acceptance gate is lightweight and must always run
    acceptLog.info('Evaluating acceptance gate...');

    const report = evaluateAcceptance(state);

    // Log every blocker at error level
    for (const blocker of report.blockers) {
        acceptLog.error(`BLOCKER: ${blocker}`);
    }

    // Log status
    acceptLog.info(`Acceptance status: ${report.status.toUpperCase()} — ${report.criteria.filter(c => c.passed).length}/${report.criteria.length} criteria passed, ${report.blockers.length} blocker(s)`);
    if (report.unrecoverable) {
        acceptLog.warn(`Run is unrecoverable: ${report.unrecoverableReason}`);
    }

    // Write acceptance report artifact
    try {
        const reportMd = acceptanceReportToMarkdown(report);
        writeArtifact({
            agentId: 'acceptance-gate',
            colorCode: 214,
            workspacePath: state.workspacePath, outputPath: state.outputPath,
            title: 'Acceptance Report',
            content: reportMd,
        });
        // Also write to outputs/<run>/acceptance-report.md
        writeOutputFile(state.outputPath, 'acceptance-report.md', reportMd);
    } catch (err: any) {
        acceptLog.warn(`Failed to write acceptance report artifact: ${err.message}`);
    }

    // Convert acceptance blockers to bugs for the bugfix loop
    const acceptanceBugs = acceptanceBlockersToBugs(report);

    const transcript: TranscriptMessage[] = [
        msg('acceptance-gate', 'acceptance-gate',
            `Acceptance gate: ${report.status.toUpperCase()} — ${report.blockers.length} blocker(s)${report.unrecoverable ? ' [UNRECOVERABLE]' : ''}`),
    ];

    emitRunEvent('acceptance:result', {
        status: report.status,
        blockers: report.blockers.length,
        unrecoverable: report.unrecoverable,
        criteria: report.criteria.map(c => ({ id: c.id, passed: c.passed })),
    });
    emitRunEvent('phase:end', { phase: 'acceptance-gate', status: report.status });

    return {
        acceptance: report,
        unrecoverable: report.unrecoverable ? { flag: true, reason: report.unrecoverableReason ?? 'unknown' } : null,
        bugs: acceptanceBugs,
        phase: 'acceptance-gate' as PhaseName,
        transcript,
    };
}
