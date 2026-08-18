/**
 * Pipeline node barrel — re-exports all 13 phase node functions.
 *
 * Consumers (graph.ts, tests) import from this module:
 *   import { intakeNode, architectNode, ... } from './nodes';
 */

// Phase 1: Intake
export { intakeNode } from './intake';

// Phase 1b: Codebase Analyzer (maintain mode only)
// Phase 2: Architect
// Phase 3: Product Manager
// Phase 4: DBA
// Phase 5: Team Leader
export {
    codebaseAnalyzerNode,
    architectNode,
    productManagerNode,
    dbaNode,
    teamLeaderNode,
} from './planning';

// Phase 6: Development (fan-out)
export { developmentNode } from './development';

// Phase 7: QA
export { qaNode } from './qa';

// Phase 8: Bug-fix Triage
export { bugfixTriageNode } from './bugfix-triage';

// Phase 9: DevOps
export { devopsNode } from './devops';

// Phase 9b: E2E Testing
export { e2eNode } from './e2e';

// Phase 10: Acceptance Gate
export { acceptanceNode } from './acceptance';

// Phase 11: Finalize
export { finalizeNode } from './finalize';
