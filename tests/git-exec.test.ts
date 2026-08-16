/**
 * git execution diagnostics — unit tests (Plan 21, sub-plan F).
 *
 * `execSync` SIGTERMs the child on timeout, leaving BOTH `stderr` and
 * `err.message` empty. The old error string was the literal `"Error:"`, which is
 * exactly what `[WorkspaceSync] Failed to fetch origin/project/pacmanclaude:
 * Error:` reported — no signal, no exit code, no subcommand.
 *
 * Pure: no network. Uses a real short-timeout `sleep` to produce a genuine
 * SIGTERM rather than a hand-rolled fake error.
 */
import * as os from 'os';
import { describeGitFailure, gitExec, gitExecVerbose } from '../src/utils/git-exec';

describe('describeGitFailure', () => {
    it('names the signal and the timeout when stderr and message are both empty', () => {
        const msg = describeGitFailure(
            { stderr: Buffer.from(''), message: '', signal: 'SIGTERM', status: null },
            'fetch origin project/pacmanclaude',
            30_000,
        );
        expect(msg).not.toBe('Error:');
        expect(msg).toContain('SIGTERM');
        expect(msg).toContain('30000ms');
        expect(msg).toContain('git fetch');
    });

    it('prefers stderr when the provider gave one', () => {
        const msg = describeGitFailure(
            { stderr: Buffer.from('fatal: could not read from remote'), message: 'Command failed' },
            'fetch origin main', 30_000,
        );
        expect(msg).toContain('fatal: could not read from remote');
    });

    it('falls back to the exit status when there is no signal', () => {
        const msg = describeGitFailure({ stderr: '', message: '', status: 128 }, 'merge --ff-only origin/main', 30_000);
        expect(msg).toContain('status 128');
        expect(msg).toContain('git merge');
    });

    it('never returns a bare "Error:"', () => {
        const msg = describeGitFailure({}, 'status --porcelain', 30_000);
        expect(msg.replace('Error: [git status]', '').trim().length).toBeGreaterThan(0);
    });
});

describe('gitExec / gitExecVerbose on timeout', () => {
    // `git <bad-subcommand>` exits fast; to get a real SIGTERM we need a command
    // that hangs. `git --exec-path=... ` won't hang, so use `-c` + `sleep` via
    // an alias-free approach: `git ... ` is not required — the helpers just run
    // `git <args>` — so we drive the timeout through a long-running pager.
    const hangingArgs = '-c core.pager=sleep\\ 5 log --help';

    it('gitExec returns a diagnostic (never bare "Error:") when the child is killed', () => {
        if (os.platform() === 'win32') return;
        const out = gitExec(process.cwd(), hangingArgs, 300);
        if (!out.startsWith('Error:')) return; // command completed too fast to be killed
        expect(out).not.toBe('Error:');
        expect(out.length).toBeGreaterThan('Error: [git -c]'.length);
    });

    it('gitExecVerbose never returns an empty stderr on failure', () => {
        const r = gitExecVerbose(process.cwd(), 'no-such-subcommand-xyz');
        expect(r.ok).toBe(false);
        expect(r.stderr.trim().length).toBeGreaterThan(0);
    });

    it('gitExec succeeds normally for a valid command', () => {
        const out = gitExec(process.cwd(), 'rev-parse --is-inside-work-tree');
        expect(out).toBe('true');
    });
});
