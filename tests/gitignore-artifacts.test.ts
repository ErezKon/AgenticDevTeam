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
