/**
 * `logger.debug()` is gated by DEBUG_MODE, and in debug mode every logger and
 * tool-action line is mirrored into the debug trace so trace.jsonl is a single
 * self-sufficient timeline.
 */
import * as path from 'path';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { readJsonl } from './helpers/jsonl';

let outDir: string;
let consoleSpy: jest.SpyInstance;

beforeEach(() => {
    outDir = makeTempDir('adt-logger-gating-');
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => cleanupDir(outDir));

/** Load logger + debug-trace in an isolated registry with DEBUG_MODE set as given. */
function loadModules(debugMode: boolean): { logger: typeof import('../src/utils/logger'); debugTrace: typeof import('../src/utils/debug-trace') } {
    let modules: ReturnType<typeof loadModules> | undefined;
    jest.isolateModules(() => {
        jest.doMock('../src/config', () => ({ ...jest.requireActual('../src/config'), DEBUG_MODE: debugMode }));
        modules = {
            debugTrace: require('../src/utils/debug-trace'),
            logger: require('../src/utils/logger'),
        };
    });
    return modules!;
}

const printed = () => consoleSpy.mock.calls.map(call => String(call[0]));

describe('logger debug gating', () => {
    it('suppresses debug lines when DEBUG_MODE is off', () => {
        const { logger } = loadModules(false);
        const log = logger.getLogger('[Gate]', 1);

        log.debug('hidden detail');
        log.info('visible summary');

        expect(printed().some(line => line.includes('hidden detail'))).toBe(false);
        expect(printed().some(line => line.includes('INFO visible summary'))).toBe(true);
    });

    it('prints debug lines and mirrors every line into the trace when DEBUG_MODE is on', () => {
        const { logger, debugTrace } = loadModules(true);
        debugTrace.initDebugTrace(outDir);
        const log = logger.getLogger('[Gate]', 1);

        log.debug('visible detail');
        log.warn('careful');
        logger.logToolAction('\x1b[38;5;202m[git]\x1b[0m status --short');

        expect(printed().some(line => line.includes('DEBUG visible detail'))).toBe(true);
        const logs = readJsonl(path.join(outDir, 'debug', 'trace.jsonl')).filter(r => r.kind === 'log');
        expect(logs).toEqual([
            expect.objectContaining({ level: 'DEBUG', tag: '[Gate]', message: 'visible detail' }),
            expect.objectContaining({ level: 'WARN', tag: '[Gate]', message: 'careful' }),
            expect.objectContaining({ level: 'TOOL', message: '[git] status --short' }),
        ]);
    });
});
