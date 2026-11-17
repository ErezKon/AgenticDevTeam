/**
 * Dependencies installed when a branch worktree is created (Plan 30-07).
 *
 * A fresh worktree has no node_modules, so every dev agent started by running
 * `npm install` — model turns of ~15k input tokens each, repeated for every
 * agent and respawn on the branch — and the persona told it to. Now the
 * conductor installs once per worktree, before any agent runs, with the quality
 * gates' install command (which later skips the install as up to date); the
 * workspace snapshot tells the agent the dependencies are installed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../utils/logger';
import { execCapture, safeChildEnv, NON_INTERACTIVE_ENV } from '../../utils/shell-exec';
import { renderTerminalOutput, summariseTestOutput } from '../../utils/terminal-output';
import { detectStackRoots, GATE_COMMANDS, shouldSkipInstall } from '../quality-gates';
import { PR_TEST_INSTALL_TIMEOUT_MS } from '../../config';

const log = getLogger('[PR-Workflow]', 135);

export interface DepsInstallResult {
    /** Package roots (relative, '.' = the worktree) installed now. */
    installed: string[];
    /** Package roots whose node_modules were already up to date. */
    upToDate: string[];
    /** Roots whose install failed — the agent can still install, and the gates install again. */
    failed: Array<{ root: string; exitCode: number; output: string }>;
}

/**
 * Install the Node dependencies of every package root of `worktree`; members of
 * an npm workspace are installed through their workspace root. Never throws.
 */
export async function preinstallWorktreeDeps(worktree: string): Promise<DepsInstallResult> {
    const result: DepsInstallResult = { installed: [], upToDate: [], failed: [] };
    const install = GATE_COMMANDS.node.install;
    if (!install) return result;

    for (const root of detectStackRoots(worktree).filter(r => r.stack === 'node' && !r.isWorkspaceMember)) {
        const label = root.relDir || '.';
        if (shouldSkipInstall('node', root.dir)) {
            result.upToDate.push(label);
            continue;
        }
        const startedAt = Date.now();
        const run = await execCapture(install, {
            cwd: root.dir, timeout: PR_TEST_INSTALL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024,
            env: safeChildEnv({ ...NON_INTERACTIVE_ENV }),
        });
        if (run.exitCode === 0) {
            markFresh(root.dir);
            result.installed.push(label);
            log.info(`Dependencies pre-installed in ${label} (${((Date.now() - startedAt) / 1000).toFixed(0)}s)`);
        } else {
            const output = summariseTestOutput(renderTerminalOutput(`${run.stdout}\n${run.stderr}`), 1000);
            result.failed.push({ root: label, exitCode: run.exitCode, output });
            log.warn(`Dependency pre-install failed in ${label} (exit ${run.exitCode}) — the agent can still install: ${output.slice(-300)}`);
        }
    }
    return result;
}

/**
 * After a successful install, make npm's hidden lockfile newer than package.json and
 * package-lock.json — `npm install` may write the lockfile last — so `shouldSkipInstall()`,
 * and with it the gates and the workspace snapshot, see the install as current.
 */
function markFresh(dir: string): void {
    const hiddenLock = path.join(dir, 'node_modules', '.package-lock.json');
    try {
        if (!fs.existsSync(hiddenLock)) return;
        const manifests = ['package.json', 'package-lock.json'].map(f => path.join(dir, f)).filter(f => fs.existsSync(f));
        // 1 ms past the newest manifest — file times are finer than a Date's milliseconds
        const seconds = (Math.max(Date.now(), ...manifests.map(f => fs.statSync(f).mtimeMs)) + 1) / 1000;
        fs.utimesSync(hiddenLock, seconds, seconds);
    } catch (err: any) {
        log.debug(`Could not refresh ${hiddenLock}: ${err.message}`);
    }
}
