/**
 * What run_command returns (Plan 30-07): output rendered the way a terminal
 * shows it, long test output cut to failures and summary lines, a
 * non-interactive environment without secrets, and honest pipeline exit codes.
 *
 * In the claudeopus5 run one Karma run returned 16 kB of progress redraws and
 * escape sequences, and `npm test | tail -20` always reported tail's exit 0.
 */
jest.mock('../src/utils/logger', () => ({
    getLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }),
    logToolAction: () => undefined,
    setRunLogPath: () => undefined,
}));
jest.mock('../src/config', () => ({
    GIT_USER_NAME: 'Test',
    GIT_USER_EMAIL: 'test@test.local',
    SHELL_ALLOW_HOST: true,
    SHELL_DEFAULT_TIMEOUT_S: 60,
    SHELL_MAX_TIMEOUT_S: 900,
    MAX_TOOL_RESULT_CHARS: 10_000,
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createShellTool } from '../src/tools/shell/shell-tools';

const karma = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plan30', 'karma-stdout-seq2273.json'), 'utf-8'));
const KARMA_STDOUT: string = karma.stdoutLines.join('\n');
const FAILED_SPEC = 'ScoreStorageService saveHighScore [US-027#1] should truncate the list to top 10 scores FAILED';

/** Answer the one spawn — execFile under bash, exec otherwise — with this output; exposes its options. */
function fakeSpawn(stdout: string, stderr: string, exitCode: number): { options: () => any } {
    const cp = require('child_process');
    const answer = ((...args: unknown[]) => {
        const cb = args[args.length - 1] as Function;
        cb(exitCode === 0 ? null : Object.assign(new Error('Command failed'), { code: exitCode }), stdout, stderr);
        return { pid: 1 };
    }) as any;
    const exec = jest.spyOn(cp, 'exec').mockImplementation(answer);
    const execFile = jest.spyOn(cp, 'execFile').mockImplementation(answer);
    return { options: () => execFile.mock.calls[0]?.[2] ?? exec.mock.calls[0]?.[1] };
}

const run = async (command: string, cwd = '/tmp/ws'): Promise<string> =>
    String(await createShellTool(cwd).invoke({ command }));

describe('run_command output (Plan 30-07)', () => {
    it('renders the Karma run to under 2 kB, the failing spec intact', async () => {
        fakeSpawn(KARMA_STDOUT, '', 1);
        const out = await run('npx ng test --watch=false');

        expect(KARMA_STDOUT.length).toBeGreaterThan(12_000);
        expect(out.length).toBeLessThan(2_100);
        expect(out.startsWith('Exit code: 1')).toBe(true);
        expect(out).toContain(FAILED_SPEC);
        expect(out).not.toContain('\x1b');
    });

    it('cuts a long test run to its failure blocks and summary lines', async () => {
        const lines = Array.from({ length: 800 }, (_, i) => `PASS src/module${i}.test.ts`);
        lines.splice(400, 0, 'FAIL src/board.test.ts', '  ● Board › renders the grid', '    Expected: 10', '    Received: 9');
        lines.push('Tests:       1 failed, 799 passed, 800 total', 'Test Suites: 1 failed, 799 passed, 800 total');
        fakeSpawn('', lines.join('\n'), 1);                      // Jest reports on stderr

        const out = await run('npm test');

        expect(out.length).toBeLessThanOrEqual(10_000);
        expect(out).toContain('stderr:');
        expect(out).toContain('● Board › renders the grid');
        expect(out).toContain('Expected: 10');
        expect(out).toContain('Tests:       1 failed, 799 passed, 800 total');
        expect(out).not.toContain('PASS src/module200.test.ts');
    });

    it('does not summarise a command that only reads a file — it keeps the head, as truncation does', async () => {
        const body = Array.from({ length: 600 }, (_, i) => `// line ${i}: some code here`).join('\n');   // ~17k chars
        fakeSpawn(body, '', 0);
        const out = await run('cat src/app.test.ts');

        expect(out).toContain('// line 0: some code here');
        expect(out).not.toContain('line(s) omitted');
    });

    it('runs with a non-interactive environment: CI, no colour, no npm notices, no secrets', async () => {
        const saved = { key: process.env.ANTHROPIC_API_KEY, nodeEnv: process.env.NODE_ENV };
        process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
        process.env.NODE_ENV = 'production';
        try {
            const spawn = fakeSpawn('ok', '', 0);
            await run('npm install');
            const env = spawn.options().env;

            expect(env).toMatchObject({
                CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', NG_CLI_ANALYTICS: 'false',
                NPM_CONFIG_FUND: 'false', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
                GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.local',
            });
            expect(env.ANTHROPIC_API_KEY).toBeUndefined();
            // A production host must not make the agent's npm install skip devDependencies
            expect(env.NODE_ENV).toBeUndefined();
        } finally {
            if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
            if (saved.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.nodeEnv;
        }
    });
});

const hasBash = process.platform !== 'win32' && ['/bin/bash', '/usr/bin/bash'].some(p => fs.existsSync(p));
const describeBash = hasBash ? describe : describe.skip;

describeBash('pipefail (Plan 30-07, real bash)', () => {
    it('a pipeline fails when any command in it fails', async () => {
        expect((await run('false | cat', os.tmpdir())).startsWith('Exit code: 1')).toBe(true);
    });

    it('a passing pipeline exits 0', async () => {
        expect(await run('echo hello | cat', os.tmpdir())).toBe('Exit code: 0\n\nstdout:\nhello');
    });
});
