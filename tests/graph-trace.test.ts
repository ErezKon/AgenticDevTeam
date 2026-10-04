/**
 * Graph node + routing tracing (DEBUG_MODE) — conductor/graph-trace.ts.
 *
 * Control-flow bugs ("why did the run loop QA → triage three times?") are
 * diagnosed from these records: node entry vitals, the update each node
 * returned, and the reason behind every conditional edge.
 */
jest.mock('../src/config', () => ({ ...jest.requireActual('../src/config'), DEBUG_MODE: true }));
jest.mock('../src/utils/logger');

import * as path from 'path';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { readJsonl } from './helpers/jsonl';
import { makeState } from './helpers/state-factory';
import { RunContext, runWithContext } from '../src/utils/run-context';
import { initDebugTrace, trace, _resetDebugTrace } from '../src/utils/debug-trace';
import { traceNode, traceRoute, stateVitals, summarizeUpdate } from '../src/conductor/graph-trace';
import type { ProjectStateType } from '../src/conductor/state';

let outDir: string;

beforeEach(() => {
    _resetDebugTrace();
    outDir = makeTempDir('adt-graph-trace-');
});

afterEach(() => cleanupDir(outDir));

const records = (file = 'trace.jsonl') => readJsonl(path.join(outDir, 'debug', file)).filter(r => r.kind !== 'run');
const inRun = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(new RunContext('run-graph'), async () => {
    initDebugTrace(outDir);
    return fn();
});

describe('traceNode', () => {
    it('records start (vitals) and end (update summary) and attributes nested records to the node', async () => {
        const node = traceNode('architect', async (_state: ProjectStateType) => {
            trace({ kind: 'log', level: 'INFO', message: 'inside node' });
            return { phase: 'product-manager', epics: [{ id: 'E-1' }, { id: 'E-2' }], architecture: { style: 'layered', components: [] } } as any;
        });

        await inRun(() => node(makeState({ phase: 'architect' })));

        const recs = records();
        expect(recs.map(r => `${r.kind}:${r.event ?? ''}`)).toEqual(['node:start', 'log:', 'node:end']);
        expect(recs[0]).toMatchObject({ node: 'architect', phase: 'architect', vitals: { phase: 'architect', counts: { epics: 0 } } });
        expect(recs[1]).toMatchObject({ message: 'inside node', phase: 'architect' });
        expect(recs[2]).toMatchObject({
            node: 'architect', nextPhase: 'product-manager',
            update: {
                phase: 'product-manager',
                epics: { count: 2, ids: ['E-1', 'E-2'] },
                architecture: { keys: ['style', 'components'] },
            },
        });
        expect(typeof recs[2].durationMs).toBe('number');
    });

    it('records node errors with the stack and rethrows the same error', async () => {
        const boom = new Error('planner exploded');
        const node = traceNode('dba', async (_state: ProjectStateType) => { throw boom; });

        await expect(inRun(() => node(makeState()))).rejects.toBe(boom);

        const failure = records('errors.jsonl').find(r => r.kind === 'node');
        expect(failure).toMatchObject({ event: 'error', node: 'dba', error: { message: 'planner exploded' } });
        expect(failure.error.stack).toContain('planner exploded');
    });
});

describe('traceRoute', () => {
    it('records routing decisions with the state that drove them', async () => {
        const router = traceRoute('qa', (_state: ProjectStateType) => 'bugfix-triage');
        let to = '';

        await inRun(async () => { to = router(makeState({ phase: 'qa', iteration: { bugfix: 1 } })); });

        expect(to).toBe('bugfix-triage');
        const [route] = records().filter(r => r.kind === 'route');
        expect(route).toMatchObject({ event: 'decision', from: 'qa', to: 'bugfix-triage', vitals: { phase: 'qa', iteration: { bugfix: 1 } } });
    });
});

describe('summaries', () => {
    it('summarizeUpdate reports array sizes with ids, object keys and scalar values', () => {
        expect(summarizeUpdate({
            phase: 'qa', bugs: [{ id: 'B-1' }], fixedBugIds: ['B-0'], testPlan: { cases: [] }, cancelled: false,
        })).toEqual({
            phase: 'qa', bugs: { count: 1, ids: ['B-1'] }, fixedBugIds: { count: 1, ids: ['B-0'] },
            testPlan: { keys: ['cases'] }, cancelled: false,
        });
        expect(summarizeUpdate(undefined)).toBeUndefined();
    });

    it('stateVitals surfaces stop reasons and unrecoverable halts', () => {
        expect(stateVitals(makeState({
            cancelled: true, _stopReason: 'budget-exhausted:cost', unrecoverable: { flag: true, reason: 'zero-progress rounds' },
        }))).toMatchObject({ cancelled: true, stopReason: 'budget-exhausted:cost', unrecoverable: 'zero-progress rounds' });
    });
});
