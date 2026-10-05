/**
 * Dependencies pre-installed when a branch worktree is created (Plan 30-07):
 * the skip logic, the install command and its environment, and failures.
 */
jest.mock('../src/utils/logger', () => ({
    getLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }),
    setRunLogPath: () => undefined,
    logToolAction: () => undefined,
}));

import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { preinstallWorktreeDeps } from '../src/conductor/pr/worktree-deps';
import { GATE_COMMANDS, shouldSkipInstall } from '../src/conductor/quality-gates';

let dir: string;
beforeEach(() => { dir = makeTempDir('adt-worktree-deps-'); });
afterEach(() => cleanupDir(dir));

/** Answer every `exec` with `exitCode`, creating node_modules like npm does on success. */
function fakeInstall(exitCode: number): jest.SpyInstance {
    const cp = require('child_process');
    return jest.spyOn(cp, 'exec').mockImplementation(((_command: string, options: { cwd: string }, cb: Function) => {
        if (exitCode === 0) {
            fs.mkdirSync(path.join(options.cwd, 'node_modules'), { recursive: true });
            fs.writeFileSync(path.join(options.cwd, 'node_modules', '.package-lock.json'), '{}');
            fs.writeFileSync(path.join(options.cwd, 'package-lock.json'), '{}');   // written last, as npm install may
        }
        cb(exitCode === 0 ? null : Object.assign(new Error('Command failed'), { code: exitCode }), 'added 12 packages', exitCode ? 'npm ERR! code E404' : '');
        return { pid: 1 };
    }) as any);
}

const writePackage = (at: string, pkg: Record<string, unknown> = { name: 'app', scripts: { test: 'jest' } }): void => {
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify(pkg));
};

describe('preinstallWorktreeDeps (Plan 30-07)', () => {
    it('does nothing without a package.json', async () => {
        const exec = fakeInstall(0);
        expect(await preinstallWorktreeDeps(dir)).toEqual({ installed: [], upToDate: [], failed: [] });
        expect(exec).not.toHaveBeenCalled();
    });

    it('installs with the gates\' command and a non-interactive environment, and leaves node_modules current', async () => {
        writePackage(dir);
        const exec = fakeInstall(0);

        const result = await preinstallWorktreeDeps(dir);

        expect(result.installed).toEqual(['.']);
        expect(exec).toHaveBeenCalledTimes(1);
        const [command, options] = exec.mock.calls[0];
        expect(command).toBe(GATE_COMMANDS.node.install);
        expect(options.cwd).toBe(dir);
        expect(options.env).toMatchObject({ CI: '1', NO_COLOR: '1', NPM_CONFIG_FUND: 'false' });
        // The hidden lockfile was refreshed after the lockfile was written: the gates and the snapshot see it
        expect(shouldSkipInstall('node', dir)).toBe(true);
    });

    it('skips a root whose node_modules is already current', async () => {
        writePackage(dir);
        fs.mkdirSync(path.join(dir, 'node_modules'));
        const hiddenLock = path.join(dir, 'node_modules', '.package-lock.json');
        fs.writeFileSync(hiddenLock, '{}');
        const later = new Date(Date.now() + 5_000);
        fs.utimesSync(hiddenLock, later, later);
        const exec = fakeInstall(0);

        expect(await preinstallWorktreeDeps(dir)).toEqual({ installed: [], upToDate: ['.'], failed: [] });
        expect(exec).not.toHaveBeenCalled();
    });

    it('installs an npm workspace through its root only', async () => {
        writePackage(dir, { name: 'mono', workspaces: ['packages/*'] });
        writePackage(path.join(dir, 'packages', 'web'), { name: 'web', scripts: { test: 'jest' } });
        const exec = fakeInstall(0);

        const result = await preinstallWorktreeDeps(dir);

        expect(result.installed).toEqual(['.']);
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it('reports a failed install without throwing', async () => {
        writePackage(dir);
        fakeInstall(1);

        const result = await preinstallWorktreeDeps(dir);

        expect(result.installed).toEqual([]);
        expect(result.failed).toEqual([{ root: '.', exitCode: 1, output: expect.stringContaining('npm ERR!') }]);
    });
});
