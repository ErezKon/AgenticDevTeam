/**
 * DEBUG_MODE=false is the default and must be indistinguishable from a build
 * without debug tracing: no files are written and every hook hands back the
 * original function/object, so behaviour cannot change.
 */
jest.mock('../src/config', () => ({ ...jest.requireActual('../src/config'), DEBUG_MODE: false }));
jest.mock('../src/utils/logger');

import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { RunContext, runWithContext } from '../src/utils/run-context';
import {
    initDebugTrace, trace, traceToolCall, traceOctokit, withTraceContext, writeDebugSummary, isDebugMode,
} from '../src/utils/debug-trace';
import { traceNode, traceRoute } from '../src/conductor/graph-trace';
import { execSync } from '../src/utils/shell-exec';
import type { ProjectStateType } from '../src/conductor/state';

let outDir: string;

beforeEach(() => {
    outDir = makeTempDir('adt-debug-off-');
});

afterEach(() => cleanupDir(outDir));

describe('with DEBUG_MODE=false', () => {
    it('reports debug mode as off and writes no debug folder', async () => {
        expect(isDebugMode()).toBe(false);
        await runWithContext(new RunContext('run-off'), async () => {
            expect(initDebugTrace(outDir)).toBeNull();
            trace({ kind: 'log', level: 'INFO', message: 'ignored' });
            expect(writeDebugSummary()).toBeNull();
            expect(execSync('echo still-runs', { encoding: 'utf-8' })).toBe('still-runs\n');
        });
        expect(fs.existsSync(path.join(outDir, 'debug'))).toBe(false);
    });

    it('returns every wrapper unchanged', () => {
        const toolFn = async () => 'x';
        const octokit = {};
        const node = async (state: ProjectStateType) => ({ phase: state.phase });
        const router = (_state: ProjectStateType) => 'finalize';

        expect(traceToolCall('agent', 'tool', toolFn)).toBe(toolFn);
        expect(traceOctokit(octokit, 'github')).toBe(octokit);
        expect(traceNode('qa', node)).toBe(node);
        expect(traceRoute('qa', router)).toBe(router);
        expect(withTraceContext({ phase: 'qa' }, () => 7)).toBe(7);
    });
});
