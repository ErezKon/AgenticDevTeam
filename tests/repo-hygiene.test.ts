/**
 * Repo Hygiene — unit tests for Sub-Plan 12 (fixes A11).
 *
 * Test groups:
 * 1. ensureProjectGitignore — creates, appends, idempotent, preserves existing
 * 2. .conventions/ excluded by git after ensureProjectGitignore
 * 3. resolveConventionFiles + deployConventionsToWorkspace — targeted deployment
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureProjectGitignore } from '../src/utils/workspace';
import { resolveConventionFiles, deployConventionsToWorkspace } from '../src/utils/coding-conventions';

// Mock logger to avoid console noise
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
    logToolAction: jest.fn(),
    setRunLogPath: jest.fn(),
}));

const TIMEOUT = 15_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-hygiene-test-'));
}

function git(cwd: string, args: string): string {
    return execSync(`git ${args}`, {
        cwd, encoding: 'utf-8', timeout: 10_000,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.local',
            GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.local',
        },
    }).trim();
}

// ─── Test 1: ensureProjectGitignore ──────────────────────────────────────────

describe('ensureProjectGitignore', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = createTempDir(); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('creates .gitignore with the block when none exists', () => {
        ensureProjectGitignore(tmpDir, ['.conventions/', '.worktrees/']);
        const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        expect(content).toContain('.conventions/');
        expect(content).toContain('.worktrees/');
        expect(content).toContain('AgenticDevTeam');
    }, TIMEOUT);

    it('is idempotent — calling twice produces identical output', () => {
        ensureProjectGitignore(tmpDir, ['.conventions/', '.worktrees/']);
        const first = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        ensureProjectGitignore(tmpDir, ['.conventions/', '.worktrees/']);
        const second = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        expect(second).toBe(first);
    }, TIMEOUT);

    it('preserves existing content when appending', () => {
        const existing = 'node_modules/\ndist/\n';
        fs.writeFileSync(path.join(tmpDir, '.gitignore'), existing, 'utf-8');
        ensureProjectGitignore(tmpDir, ['.conventions/', '.worktrees/']);
        const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        expect(content).toContain('node_modules/');
        expect(content).toContain('dist/');
        expect(content).toContain('.conventions/');
        expect(content).toContain('.worktrees/');
    }, TIMEOUT);

    it('replaces the managed block when entries change', () => {
        ensureProjectGitignore(tmpDir, ['.conventions/']);
        ensureProjectGitignore(tmpDir, ['.conventions/', '.worktrees/', '.env']);
        const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        expect(content).toContain('.worktrees/');
        expect(content).toContain('.env');
        // Should only have one marker block
        const markerCount = (content.match(/AgenticDevTeam \(do not edit/g) || []).length;
        expect(markerCount).toBe(1);
    }, TIMEOUT);

    it('handles .gitignore without trailing newline', () => {
        fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/', 'utf-8');
        ensureProjectGitignore(tmpDir, ['.conventions/']);
        const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        expect(content).toContain('node_modules/');
        expect(content).toContain('.conventions/');
    }, TIMEOUT);
});

// ─── Test 2: .conventions/ excluded by git ───────────────────────────────────

describe('.conventions/ excluded by git after ensureProjectGitignore', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = createTempDir(); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('.conventions/ files are not staged by git add .', () => {
        // Init a git repo
        git(tmpDir, 'init');
        git(tmpDir, 'checkout -b main');

        // Write a convention file
        const convDir = path.join(tmpDir, '.conventions');
        fs.mkdirSync(convDir, { recursive: true });
        fs.writeFileSync(path.join(convDir, 'Universal.md'), '# Test convention\n');

        // Write ensureProjectGitignore
        ensureProjectGitignore(tmpDir, ['.conventions/', '.worktrees/']);

        // Stage everything
        git(tmpDir, 'add .');

        // Check status — .conventions/ should NOT be staged
        const status = git(tmpDir, 'status --porcelain');
        expect(status).not.toContain('.conventions/');
        expect(status).toContain('.gitignore');
    }, TIMEOUT);
});

// ─── Test 3: Targeted convention deployment ──────────────────────────────────

describe('targeted convention deployment via resolveConventionFiles + deployConventionsToWorkspace', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = createTempDir(); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('resolveConventionFiles for React + Go backend returns expected files, not SCSS', () => {
        const files = resolveConventionFiles(
            ['React'],
            [{ layer: 'backend', choice: 'Go', alternatives: [], rationale: '' }],
        );
        expect(files).toContain('Universal.md');
        expect(files).toContain('React.md');
        expect(files).toContain('Go.md');
        expect(files).not.toContain('SCSS.md');
        expect(files).not.toContain('Java.md');
    }, TIMEOUT);

    it('deployConventionsToWorkspace copies exactly the resolved set', () => {
        const files = resolveConventionFiles(
            ['React'],
            [{ layer: 'backend', choice: 'Go', alternatives: [], rationale: '' }],
        );
        const deployed = deployConventionsToWorkspace(tmpDir, files);

        // Check that exactly the expected files were deployed
        const convDir = path.join(tmpDir, '.conventions');
        expect(fs.existsSync(convDir)).toBe(true);

        const deployedNames = fs.readdirSync(convDir);
        for (const f of files) {
            expect(deployedNames).toContain(f);
        }

        // Should NOT contain files outside the resolved set (like SCSS.md, Java.md)
        for (const f of deployedNames) {
            expect(files).toContain(f);
        }

        // deployed paths should match
        expect(deployed.length).toBe(files.length);
    }, TIMEOUT);
});
