#!/usr/bin/env npx tsx
/**
 * Interactive CLI for the AgenticDevTeam multi-agent system.
 *
 * Supports:
 * - Autonomous mode: full pipeline runs unattended.
 * - Human-in-the-loop mode: pauses after each phase for approve/deny/enhance.
 * - Requirements from file path or inline text.
 *
 * Sub-Plan 25-09: Split into focused modules under src/cli/.
 * This file is now a thin entry point — all logic lives in:
 *   cli/printers.ts  — display helpers (header, roster, artifacts, phase status)
 *   cli/prompts.ts   — readline wrapper, requirements gathering, repo target
 *   cli/hitl-loop.ts — unified HITL decision loop (was triplicated)
 *   cli/menu.ts      — main menu + run-start functions
 */
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;

// TLS: honour NODE_EXTRA_CA_CERTS for corporate CAs instead of disabling
// certificate validation globally. (Plan 25-02, D1)
import './env';

import { installProcessHandlers } from './utils/crash-handlers';
import { LogColors, color256 } from './utils/log-colors.util';
import { mainMenu } from './cli/menu';

const TAG = `${color256(46)}[CLI]${LogColors.RESET}`;

// ─── Signal handlers — flush token report on unexpected exit ─────────────────
installProcessHandlers((msg) => console.error(`${TAG} ${msg}`));

// ─── Entry point (guarded so cli.ts is importable without side effects) ──────
if (require.main === module) {
    mainMenu().catch((err) => {
        console.error(`${TAG} Fatal error: ${err.message}`);
        process.exit(1);
    });
}

// Re-export for backward compatibility (tests import HitlDecision etc.)
export { mainMenu } from './cli/menu';
export { driveHitlSession } from './cli/hitl-loop';
export { ask, getRequirements, getRepoTarget, closeReadline } from './cli/prompts';
export {
    printHeader, printAgentRoster, printArtifactReport,
    printAllArtifacts, printPhaseStatus, printStateJson,
} from './cli/printers';
