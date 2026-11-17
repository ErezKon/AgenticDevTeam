/**
 * Plan 30-F: graceful shutdown re-enters the RunContext each run registered from.
 *
 * Signal handlers execute outside every AsyncLocalStorage scope, so before the
 * fix `getRunContext()` was `undefined` at SIGINT time and the shutdown saved no
 * state.json `_stopReason`, no ledger entry and no token report — while still
 * printing "Graceful shutdown complete" (session 2 of the pacman-live-analysis loop).
 */
import * as fs from 'fs';
import * as path from 'path';
import { RunContext, getRunContext, runWithContext } from '../src/utils/run-context';
import { _resetShutdown, gracefulShutdown, onGracefulShutdown, registerRunShutdown } from '../src/utils/crash-handlers';
import { cleanupDir, makeTempDir } from './helpers/tmp';
import { readJsonl } from './helpers/jsonl';

jest.mock('../src/utils/logger');

describe('gracefulShutdown', () => {
    let dir: string;
    let exitSpy: jest.SpyInstance;

    beforeEach(() => {
        _resetShutdown();
        dir = makeTempDir('graceful-shutdown-');
        exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        cleanupDir(dir);
    });

    async function registerRun(id: string, phase: string): Promise<RunContext> {
        const ctx = new RunContext(id);
        ctx.ledger.outputPath = dir;
        await runWithContext(ctx, async () => {
            registerRunShutdown();
            ctx.lastKnownState = { outputPath: dir, phase, cancelled: false, _stopReason: null };
        });
        return ctx;
    }

    it('saves the registering run\'s state and ledger entry although the signal arrives outside its context', async () => {
        await registerRun('run-a', 'development');
        expect(getRunContext()).toBeUndefined();

        gracefulShutdown('SIGINT', () => undefined);

        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        expect(state).toEqual(expect.objectContaining({ cancelled: true, _stopReason: 'manual-kill', phase: 'development' }));
        expect(readJsonl(path.join(dir, 'ledger.jsonl'))).toContainEqual(
            expect.objectContaining({ kind: 'invariant', id: 'graceful-shutdown', phase: 'development' }),
        );
        expect(exitSpy).toHaveBeenCalledWith(130);
    });

    it('records an uncaught crash as crashed and exits 1', async () => {
        await registerRun('run-b', 'qa');

        gracefulShutdown('uncaughtException', () => undefined);

        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        expect(state._stopReason).toBe('crashed');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('runs custom hooks inside the RunContext they were registered from', async () => {
        const seen: Array<string | undefined> = [];
        const ctx = new RunContext('run-c');
        await runWithContext(ctx, async () => onGracefulShutdown(() => seen.push(getRunContext()?.id)));

        gracefulShutdown('SIGTERM', () => undefined);

        expect(seen).toEqual(['run-c']);
        expect(exitSpy).toHaveBeenCalledWith(143);
    });

    // Plan 30-V (F27): Ctrl+C at the CLI menu after a finished run overwrote its final state.
    it('leaves a finished (disposed) run untouched', async () => {
        const ctx = new RunContext('run-done');
        ctx.ledger.outputPath = dir;
        await runWithContext(ctx, async () => {
            const dispose = registerRunShutdown();
            ctx.lastKnownState = { outputPath: dir, phase: 'finalize', cancelled: false, _stopReason: null };
            dispose();
        });

        gracefulShutdown('SIGINT', () => undefined);

        expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
        expect(exitSpy).toHaveBeenCalledWith(130);
    });

    it('shuts down only once', async () => {
        await registerRun('run-d', 'architect');
        gracefulShutdown('SIGINT', () => undefined);
        gracefulShutdown('SIGINT', () => undefined);
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });
});
