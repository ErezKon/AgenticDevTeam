/**
 * Development-phase transcript entries for the PR workflow modules.
 *
 * Plan 30-02: replaces the identical `ts()` + `msg()` pair that the
 * orchestrator, review loop, escalation and strong fixer each declared.
 */
import type { PhaseName, TranscriptMessage } from '../../agents/_shared/base-schemas';

export function msg(agentId: string, message: string): TranscriptMessage {
    return { timestamp: new Date().toISOString(), agentId, phase: 'development' as PhaseName, message };
}
