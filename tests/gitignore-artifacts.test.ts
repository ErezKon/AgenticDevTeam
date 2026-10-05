/**
 * Gitignore entries and pipeline-artifact placement (Plan 22, G1/G4).
 *
 * ## The bugs these tests pin
 *
 * G1 — the managed .gitignore block had no `test-results/` or `playwright-report/`
 * entry, so commit `577ee56f` of the pacmanclaude branch added **111
 * test-results/ files and 7 playwright-report/ files**. The reviewer spent a
 * CRITICAL comment on them.
 *
 * G4 (revised) — mission reports live in the product repo by default (docs/agents/).
 * Reviewers are instructed to skip docs/agents/*.md files.
 * Set AGENT_ARTIFACTS_IN_REPO=false to redirect to outputs/<run>/agents/.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── G1 ─────────────────────────────────────────────────────────────────────

describe('getGitignoreEntriesForStack (Plan 22 G1)', () => {
    function load(configOverrides: Record<string, unknown> = {}) {
        jest.resetModules();
        jest.doMock('../src/config', () => ({
            GENERATED_PROJECTS_DIR: '/tmp/generated',
            OUTPUTS_DIR: '/tmp/outputs',
            AGENT_ARTIFACTS_IN_REPO: true,
            ...configOverrides,
        }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../src/utils/workspace');
    }

    it.each([
        'test-results/',
        'playwright-report/',
        'blob-report/',
        '.playwright/',
        '.vitest/',
        'junit.xml',
    ])('always ignores %s — the artifacts that got committed', (entry) => {
        const { getGitignoreEntriesForStack } = load();
        expect(getGitignoreEntriesForStack()).toContain(entry);
    });

    it('still ignores the pre-existing basics', () => {
        const { getGitignoreEntriesForStack } = load();
        const entries = getGitignoreEntriesForStack();
        for (const e of ['node_modules/', 'dist/', 'coverage/', '.env']) {
            expect(entries).toContain(e);
        }
    });

    it('ignores pipeline artifacts when AGENT_ARTIFACTS_IN_REPO is false', () => {
        const { getGitignoreEntriesForStack } = load({ AGENT_ARTIFACTS_IN_REPO: false });
        const entries = getGitignoreEntriesForStack();
        expect(entries).toContain('docs/agents/');
        expect(entries).toContain('.agent/');
    });

    it('does not ignore pipeline artifacts when AGENT_ARTIFACTS_IN_REPO is true', () => {
        const { getGitignoreEntriesForStack } = load({ AGENT_ARTIFACTS_IN_REPO: true });
        const entries = getGitignoreEntriesForStack();
        expect(entries).not.toContain('docs/agents/');
        expect(entries).not.toContain('.agent/');
    });

    it('ensureProjectGitignore writes the managed block with the new entries', () => {
        const { ensureProjectGitignore, getGitignoreEntriesForStack } = load();
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'adt-gitignore-'));
        try {
            ensureProjectGitignore(ws, getGitignoreEntriesForStack());
            const body = fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8');
            expect(body).toContain('test-results/');
            expect(body).toContain('playwright-report/');
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });
});

// ─── Plan 30-04: one managed block ──────────────────────────────────────────

describe('managedGitignoreEntries (Plan 30-04)', () => {
    function load(configOverrides: Record<string, unknown> = {}) {
        jest.resetModules();
        jest.doMock('../src/config', () => ({
            GENERATED_PROJECTS_DIR: '/tmp/generated',
            OUTPUTS_DIR: '/tmp/outputs',
            AGENT_ARTIFACTS_IN_REPO: true,
            ...configOverrides,
        }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../src/utils/workspace');
    }
    const angular = [{ layer: 'frontend', choice: 'Angular 17', alternatives: [], rationale: '' }];
    const read = (ws: string) => fs.readFileSync(path.join(ws, '.gitignore'), 'utf-8');

    // claudeopus5: the development node's own list lacked `.worktrees-failed/`.
    it.each<[string, typeof angular | undefined]>([['no tech stack (intake)', undefined], ['an Angular stack (development, PR workflow)', angular]])(
        'lists every pipeline directory for %s', (_label, stack) => {
            const { managedGitignoreEntries, PIPELINE_DIRS } = load();
            const entries: string[] = managedGitignoreEntries(stack);
            for (const dir of PIPELINE_DIRS as string[]) expect(entries).toContain(`${dir}/`);
            expect(entries).toContain('.worktrees-failed/');
        });

    it('lists .agent/ once when the stack entries already ignore it', () => {
        const { managedGitignoreEntries } = load({ AGENT_ARTIFACTS_IN_REPO: false });
        expect(managedGitignoreEntries().filter((e: string) => e === '.agent/')).toHaveLength(1);
    });

    it('writes the block only when it changes, so an unchanged block never dirties the checkout', () => {
        const { ensureProjectGitignore, managedGitignoreEntries } = load();
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'adt-gitignore-'));
        try {
            fs.writeFileSync(path.join(ws, '.gitignore'), 'secrets.txt\n');
            expect(ensureProjectGitignore(ws, managedGitignoreEntries())).toBe(true);
            const intakeBlock = read(ws);
            expect(ensureProjectGitignore(ws, managedGitignoreEntries())).toBe(false);
            expect(read(ws)).toBe(intakeBlock);

            // The development node adds the stack entries; the PR workflow then writes the identical block
            expect(ensureProjectGitignore(ws, managedGitignoreEntries(angular))).toBe(true);
            const stackBlock = read(ws);
            expect(ensureProjectGitignore(ws, managedGitignoreEntries(angular))).toBe(false);
            expect(read(ws)).toBe(stackBlock);
            expect(stackBlock).toContain('.angular/');
            expect(stackBlock).toContain('.worktrees-failed/');
            expect(stackBlock.startsWith('secrets.txt\n')).toBe(true);
            expect(stackBlock.match(/AgenticDevTeam \(do not edit/g)).toHaveLength(1);
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });
});

// ─── G4 ─────────────────────────────────────────────────────────────────────

describe('writeArtifact placement (Plan 22 G4)', () => {
    function load(inRepo: boolean) {
        jest.resetModules();
        jest.doMock('../src/config', () => ({ AGENT_ARTIFACTS_IN_REPO: inRepo }));
        jest.doMock('../src/agents/registry', () => ({ getAgentEntry: () => ({ tag: '[ARCH]' }) }));
        jest.doMock('../src/utils/logger', () => ({
            getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
            logToolAction: jest.fn(),
        }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../src/agents/_shared/artifact');
    }

    let ws: string;
    let out: string;
    beforeEach(() => {
        ws = fs.mkdtempSync(path.join(os.tmpdir(), 'adt-artifact-ws-'));
        out = fs.mkdtempSync(path.join(os.tmpdir(), 'adt-artifact-out-'));
    });
    afterEach(() => {
        fs.rmSync(ws, { recursive: true, force: true });
        fs.rmSync(out, { recursive: true, force: true });
    });

    it('writes into the repo by default (reviewers skip docs/agents/)', () => {
        const { writeArtifact } = load(true);
        const ref = writeArtifact({
            agentId: 'architect', colorCode: 1, workspacePath: ws, outputPath: out,
            title: 'Architect Mission Report', content: 'body',
        });

        expect(fs.existsSync(path.join(ws, 'docs', 'agents', 'architect-mission.md'))).toBe(true);
        expect(ref.filePath).toBe(path.join('docs', 'agents', 'architect-mission.md'));
    });

    it('writes to outputs/<run>/agents/ when AGENT_ARTIFACTS_IN_REPO is false', () => {
        const { writeArtifact } = load(false);
        const ref = writeArtifact({
            agentId: 'architect', colorCode: 1, workspacePath: ws, outputPath: out,
            title: 'Architect Mission Report', content: 'body',
        });

        expect(fs.existsSync(path.join(out, 'agents', 'architect-mission.md'))).toBe(true);
        expect(fs.existsSync(path.join(ws, 'docs', 'agents'))).toBe(false);
        expect(ref.filePath).toBe(path.join('agents', 'architect-mission.md'));
    });

    it('falls back to the repo when no outputPath is supplied', () => {
        const { writeArtifact } = load(false);
        writeArtifact({
            agentId: 'architect', colorCode: 1, workspacePath: ws,
            title: 'Architect Mission Report', content: 'body',
        });
        expect(fs.existsSync(path.join(ws, 'docs', 'agents', 'architect-mission.md'))).toBe(true);
    });
});
