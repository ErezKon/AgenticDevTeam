/**
 * Coding Conventions — unit + integration tests.
 *
 * Sub-Plan 5 of Plan 15: Coding Conventions Integration for Dev Agents.
 *
 * Test groups:
 * 1. resolveConventionFiles() — mapping, deduplication, Universal.md, unknowns
 * 2. deployConventionsToWorkspace() — file copy, idempotency, directory creation
 * 3. deployAllConventionsToWorkspace() — copies all convention files
 * 4. getConventionReadInstructions() — prompt snippet generation
 * 5. Integration — prompt builders include <coding_conventions> block
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    resolveConventionFiles,
    deployConventionsToWorkspace,
    getConventionReadInstructions,
} from '../src/utils/coding-conventions';

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a temporary workspace directory for deployment tests. */
function createTempWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'conventions-test-'));
}

/** Clean up a temporary workspace directory. */
function cleanupTempWorkspace(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Test 1: resolveConventionFiles() ────────────────────────────────────────

describe('resolveConventionFiles', () => {
    it('always includes Universal.md even with empty inputs', () => {
        const result = resolveConventionFiles([], []);
        expect(result).toEqual(['Universal.md']);
    });

    it('always includes Universal.md with no tech stack', () => {
        const result = resolveConventionFiles([]);
        expect(result).toEqual(['Universal.md']);
    });

    it('maps React to React.md, JavaScript.md, TypeScript.md + Universal.md', () => {
        const result = resolveConventionFiles(['React']);
        expect(result).toContain('React.md');
        expect(result).toContain('JavaScript.md');
        expect(result).toContain('TypeScript.md');
        expect(result).toContain('Universal.md');
        expect(result).toHaveLength(4);
    });

    it('maps Angular to Angular.md, TypeScript.md + Universal.md', () => {
        const result = resolveConventionFiles(['Angular']);
        expect(result).toContain('Angular.md');
        expect(result).toContain('TypeScript.md');
        expect(result).toContain('Universal.md');
        expect(result).toHaveLength(3);
    });

    it('maps Go to Go.md + Universal.md', () => {
        const result = resolveConventionFiles(['Go']);
        expect(result).toEqual(['Go.md', 'Universal.md']);
    });

    it('maps Python to Python.md + Universal.md', () => {
        const result = resolveConventionFiles(['Python']);
        expect(result).toEqual(['Python.md', 'Universal.md']);
    });

    it('maps C# to CSharp.md + Universal.md', () => {
        const result = resolveConventionFiles(['C#']);
        expect(result).toEqual(['CSharp.md', 'Universal.md']);
    });

    it('maps C#/.NET to CSharp.md + Universal.md', () => {
        const result = resolveConventionFiles(['C#/.NET']);
        expect(result).toEqual(['CSharp.md', 'Universal.md']);
    });

    it('maps Java to Java.md + Universal.md', () => {
        const result = resolveConventionFiles(['Java']);
        expect(result).toEqual(['Java.md', 'Universal.md']);
    });

    it('maps Java/Spring to Java.md + Universal.md', () => {
        const result = resolveConventionFiles(['Java/Spring']);
        expect(result).toEqual(['Java.md', 'Universal.md']);
    });

    it('maps Vue to Vue.md, JavaScript.md, TypeScript.md + Universal.md', () => {
        const result = resolveConventionFiles(['Vue']);
        expect(result).toContain('Vue.md');
        expect(result).toContain('JavaScript.md');
        expect(result).toContain('TypeScript.md');
        expect(result).toContain('Universal.md');
    });

    it('maps Vue.js to Vue.md, JavaScript.md, TypeScript.md + Universal.md', () => {
        const result = resolveConventionFiles(['Vue.js']);
        expect(result).toContain('Vue.md');
        expect(result).toContain('JavaScript.md');
        expect(result).toContain('TypeScript.md');
        expect(result).toContain('Universal.md');
    });

    it('maps HTML/CSS to HTML.md, CSS.md + Universal.md', () => {
        const result = resolveConventionFiles(['HTML/CSS']);
        expect(result).toContain('HTML.md');
        expect(result).toContain('CSS.md');
        expect(result).toContain('Universal.md');
    });

    it('maps SCSS to SCSS.md, CSS.md + Universal.md', () => {
        const result = resolveConventionFiles(['SCSS']);
        expect(result).toContain('SCSS.md');
        expect(result).toContain('CSS.md');
        expect(result).toContain('Universal.md');
    });

    it('maps SASS to SCSS.md, CSS.md + Universal.md', () => {
        const result = resolveConventionFiles(['SASS']);
        expect(result).toContain('SCSS.md');
        expect(result).toContain('CSS.md');
        expect(result).toContain('Universal.md');
    });

    it('maps Tailwind to CSS.md + Universal.md', () => {
        const result = resolveConventionFiles(['Tailwind']);
        expect(result).toEqual(['CSS.md', 'Universal.md']);
    });

    it('maps Svelte to JavaScript.md, TypeScript.md + Universal.md', () => {
        const result = resolveConventionFiles(['Svelte']);
        expect(result).toContain('JavaScript.md');
        expect(result).toContain('TypeScript.md');
        expect(result).toContain('Universal.md');
    });

    it('maps C to C.md + Universal.md', () => {
        const result = resolveConventionFiles(['C']);
        expect(result).toEqual(['C.md', 'Universal.md']);
    });

    it('maps C++ to CPlusPlus.md + Universal.md', () => {
        const result = resolveConventionFiles(['C++']);
        expect(result).toEqual(['CPlusPlus.md', 'Universal.md']);
    });

    it('maps Node.js/Express to JavaScript.md, TypeScript.md + Universal.md', () => {
        const result = resolveConventionFiles(['Node.js/Express']);
        expect(result).toContain('JavaScript.md');
        expect(result).toContain('TypeScript.md');
        expect(result).toContain('Universal.md');
    });

    it('maps Node.js to JavaScript.md, TypeScript.md + Universal.md', () => {
        const result = resolveConventionFiles(['Node.js']);
        expect(result).toContain('JavaScript.md');
        expect(result).toContain('TypeScript.md');
        expect(result).toContain('Universal.md');
    });

    it('maps Python/FastAPI/Django to Python.md + Universal.md', () => {
        const result = resolveConventionFiles(['Python/FastAPI/Django']);
        expect(result).toEqual(['Python.md', 'Universal.md']);
    });

    // ── Case insensitivity ───────────────────────────────────────────────

    it('is case-insensitive (react, REACT, React all work)', () => {
        const lower = resolveConventionFiles(['react']);
        const upper = resolveConventionFiles(['REACT']);
        const mixed = resolveConventionFiles(['React']);
        expect(lower).toEqual(upper);
        expect(upper).toEqual(mixed);
    });

    it('is case-insensitive for Go', () => {
        const result = resolveConventionFiles(['go']);
        expect(result).toContain('Go.md');
    });

    // ── Deduplication ────────────────────────────────────────────────────

    it('deduplicates when React + TypeScript both produce TypeScript.md and JavaScript.md', () => {
        const result = resolveConventionFiles(['React', 'TypeScript']);
        const tsCount = result.filter((f) => f === 'TypeScript.md').length;
        const jsCount = result.filter((f) => f === 'JavaScript.md').length;
        expect(tsCount).toBe(1);
        expect(jsCount).toBe(1);
        expect(result).toContain('React.md');
        expect(result).toContain('Universal.md');
        expect(result).toHaveLength(4); // React.md, TypeScript.md, JavaScript.md, Universal.md
    });

    it('deduplicates when Node.js + TypeScript overlap on TypeScript.md and JavaScript.md', () => {
        const result = resolveConventionFiles(['Node.js', 'TypeScript']);
        const tsCount = result.filter((f) => f === 'TypeScript.md').length;
        const jsCount = result.filter((f) => f === 'JavaScript.md').length;
        expect(tsCount).toBe(1);
        expect(jsCount).toBe(1);
    });

    it('deduplicates SCSS + CSS (both produce CSS.md)', () => {
        const result = resolveConventionFiles(['SCSS', 'CSS']);
        const cssCount = result.filter((f) => f === 'CSS.md').length;
        expect(cssCount).toBe(1);
        expect(result).toContain('SCSS.md');
    });

    // ── Unknown languages ────────────────────────────────────────────────

    it('returns only Universal.md for unknown languages', () => {
        const result = resolveConventionFiles(['Rust', 'Haskell', 'Elixir']);
        expect(result).toEqual(['Universal.md']);
    });

    it('resolves known languages and ignores unknowns', () => {
        const result = resolveConventionFiles(['Go', 'Rust']);
        expect(result).toEqual(['Go.md', 'Universal.md']);
    });

    // ── Tech stack integration ───────────────────────────────────────────

    it('resolves files from tech stack decisions', () => {
        const techStack = [
            { layer: 'backend', choice: 'Go', alternatives: ['Rust'], rationale: 'performance' },
        ];
        const result = resolveConventionFiles([], techStack);
        expect(result).toContain('Go.md');
        expect(result).toContain('Universal.md');
    });

    it('combines agent languages and tech stack decisions', () => {
        const techStack = [
            { layer: 'frontend', choice: 'React', alternatives: ['Vue'], rationale: 'ecosystem' },
        ];
        const result = resolveConventionFiles(['Go'], techStack);
        expect(result).toContain('Go.md');
        expect(result).toContain('React.md');
        expect(result).toContain('JavaScript.md');
        expect(result).toContain('TypeScript.md');
        expect(result).toContain('Universal.md');
    });

    it('deduplicates across agent languages and tech stack', () => {
        const techStack = [
            { layer: 'frontend', choice: 'TypeScript', alternatives: [], rationale: 'types' },
        ];
        // Agent languages already include TypeScript — should not duplicate
        const result = resolveConventionFiles(['TypeScript'], techStack);
        const tsCount = result.filter((f) => f === 'TypeScript.md').length;
        expect(tsCount).toBe(1);
    });

    it('handles multiple tech stack decisions', () => {
        const techStack = [
            { layer: 'frontend', choice: 'Angular', alternatives: [], rationale: 'enterprise' },
            { layer: 'backend', choice: 'Java', alternatives: [], rationale: 'ecosystem' },
            { layer: 'infra', choice: 'Docker', alternatives: [], rationale: 'containers' },
        ];
        const result = resolveConventionFiles([], techStack);
        expect(result).toContain('Angular.md');
        expect(result).toContain('TypeScript.md');
        expect(result).toContain('Java.md');
        expect(result).toContain('Universal.md');
        // Docker is unknown — should not add extra files
    });

    it('ignores unknown tech stack choices gracefully', () => {
        const techStack = [
            { layer: 'database', choice: 'PostgreSQL', alternatives: [], rationale: 'relational' },
        ];
        const result = resolveConventionFiles([], techStack);
        // PostgreSQL not in map — only Universal.md
        expect(result).toEqual(['Universal.md']);
    });

    // ── Sorting ──────────────────────────────────────────────────────────

    it('returns results in sorted order', () => {
        const result = resolveConventionFiles(['React', 'Go', 'Python']);
        const sorted = [...result].sort();
        expect(result).toEqual(sorted);
    });
});

// ─── Test 2: deployConventionsToWorkspace() ──────────────────────────────────

describe('deployConventionsToWorkspace', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = createTempWorkspace();
    });

    afterEach(() => {
        cleanupTempWorkspace(tempDir);
    });

    it('creates the .conventions/ directory', () => {
        deployConventionsToWorkspace(tempDir, ['Universal.md']);
        const conventionsDir = path.join(tempDir, '.conventions');
        expect(fs.existsSync(conventionsDir)).toBe(true);
        expect(fs.statSync(conventionsDir).isDirectory()).toBe(true);
    });

    it('copies specified convention files into .conventions/', () => {
        const deployed = deployConventionsToWorkspace(tempDir, ['Universal.md', 'React.md']);
        expect(deployed).toContain('.conventions/Universal.md');
        expect(deployed).toContain('.conventions/React.md');

        // Verify files actually exist on disk
        expect(fs.existsSync(path.join(tempDir, '.conventions', 'Universal.md'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, '.conventions', 'React.md'))).toBe(true);
    });

    it('copies files with correct content', () => {
        deployConventionsToWorkspace(tempDir, ['Universal.md']);
        const srcContent = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'Coding Conventions, Best Practices', 'Universal.md'),
            'utf-8',
        );
        const dstContent = fs.readFileSync(
            path.join(tempDir, '.conventions', 'Universal.md'),
            'utf-8',
        );
        expect(dstContent).toBe(srcContent);
    });

    it('is idempotent — running twice does not fail', () => {
        deployConventionsToWorkspace(tempDir, ['Universal.md', 'Go.md']);
        // Second call should not throw
        expect(() => {
            deployConventionsToWorkspace(tempDir, ['Universal.md', 'Go.md']);
        }).not.toThrow();

        // Files should still be present
        expect(fs.existsSync(path.join(tempDir, '.conventions', 'Universal.md'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, '.conventions', 'Go.md'))).toBe(true);
    });

    it('skips missing convention files gracefully', () => {
        const deployed = deployConventionsToWorkspace(tempDir, ['Universal.md', 'NonExistent.md']);
        expect(deployed).toContain('.conventions/Universal.md');
        expect(deployed).not.toContain('.conventions/NonExistent.md');
        expect(deployed).toHaveLength(1);
    });

    it('returns workspace-relative paths', () => {
        const deployed = deployConventionsToWorkspace(tempDir, ['Go.md']);
        for (const p of deployed) {
            expect(p).toMatch(/^\.conventions\//);
            expect(path.isAbsolute(p)).toBe(false);
        }
    });

    it('handles empty file list', () => {
        const deployed = deployConventionsToWorkspace(tempDir, []);
        expect(deployed).toEqual([]);
        // .conventions/ directory should still be created
        expect(fs.existsSync(path.join(tempDir, '.conventions'))).toBe(true);
    });
});

// ─── Test 3: getConventionReadInstructions() ─────────────────────────────────

describe('getConventionReadInstructions', () => {
    it('returns empty string for empty file list', () => {
        expect(getConventionReadInstructions([])).toBe('');
    });

    it('wraps output in <coding_conventions> tags', () => {
        const result = getConventionReadInstructions(['Universal.md']);
        expect(result).toMatch(/^<coding_conventions>/);
        expect(result).toMatch(/<\/coding_conventions>$/);
    });

    // With CONVENTIONS_INLINE_DIGEST=true (default), the digest path is used.
    it('includes escape-hatch reference to .conventions/ in digest mode', () => {
        const result = getConventionReadInstructions(['Universal.md']);
        expect(result).toContain('.conventions/*.md');
        expect(result).toContain('read one ONLY if you need');
    });

    it('contains extracted content from convention files in digest mode', () => {
        const result = getConventionReadInstructions(['Universal.md', 'React.md']);
        // The digest should have content from the source files
        expect(result.length).toBeGreaterThan(50);
    });
});

// ─── Test 4b: getConventionReadInstructions() — fallback mode ────────────────

describe('getConventionReadInstructions (CONVENTIONS_INLINE_DIGEST=false)', () => {
    let getInstructionsFallback: typeof getConventionReadInstructions;

    beforeAll(async () => {
        // Re-import with the flag disabled to test the fallback path
        jest.resetModules();
        process.env.CONVENTIONS_INLINE_DIGEST = 'false';
        const mod = await import('../src/utils/coding-conventions');
        getInstructionsFallback = mod.getConventionReadInstructions;
    });

    afterAll(() => {
        delete process.env.CONVENTIONS_INLINE_DIGEST;
        jest.resetModules();
    });

    it('returns empty string for empty file list', () => {
        expect(getInstructionsFallback([])).toBe('');
    });

    it('includes the MUST read instruction', () => {
        const result = getInstructionsFallback(['Universal.md']);
        expect(result).toContain('BEFORE writing any code, you MUST read');
        expect(result).toContain('read_file tool');
    });

    it('lists files with .conventions/ prefix', () => {
        const result = getInstructionsFallback(['Universal.md', 'React.md']);
        expect(result).toContain('.conventions/Universal.md');
        expect(result).toContain('.conventions/React.md');
    });

    it('includes follow-all-rules instruction', () => {
        const result = getInstructionsFallback(['Universal.md']);
        expect(result).toContain('Follow ALL rules');
    });

    it('includes re-read instruction for multiple assignments', () => {
        const result = getInstructionsFallback(['Universal.md']);
        expect(result).toContain('re-read the relevant');
    });

    it('lists each file as a bullet point', () => {
        const result = getInstructionsFallback(['Go.md', 'Python.md', 'Universal.md']);
        const lines = result.split('\n');
        const bulletLines = lines.filter((l) => l.trim().startsWith('- .conventions/'));
        expect(bulletLines).toHaveLength(3);
    });
});

// ─── Test 4c: buildConventionsDigest() ───────────────────────────────────────

describe('buildConventionsDigest', () => {
    let buildConventionsDigest: typeof import('../src/utils/conventions-digest')['buildConventionsDigest'];

    beforeAll(async () => {
        const mod = await import('../src/utils/conventions-digest');
        buildConventionsDigest = mod.buildConventionsDigest;
    });

    it('returns non-empty digest for Universal.md and React.md', () => {
        const digest = buildConventionsDigest(['Universal.md', 'React.md']);
        expect(digest.length).toBeGreaterThan(0);
    });

    it('is under 1600 chars', () => {
        const digest = buildConventionsDigest(['Universal.md', 'React.md']);
        expect(digest.length).toBeLessThanOrEqual(1600);
    });

    it('returns empty string for empty file list', () => {
        expect(buildConventionsDigest([])).toBe('');
    });

    it('returns empty string for non-existent files', () => {
        expect(buildConventionsDigest(['NonExistent.md'])).toBe('');
    });

    it('contains section headers referencing file names', () => {
        const digest = buildConventionsDigest(['Universal.md', 'React.md']);
        expect(digest).toContain('[Universal.md]');
        expect(digest).toContain('[React.md]');
    });

    it('contains headings extracted from source files', () => {
        const digest = buildConventionsDigest(['Universal.md']);
        // Universal.md has headings like "Version Control", "Security", etc.
        expect(digest).toMatch(/##\s/);
    });

    it('caches results — calling twice returns the same string', () => {
        const d1 = buildConventionsDigest(['Universal.md', 'React.md']);
        const d2 = buildConventionsDigest(['Universal.md', 'React.md']);
        expect(d1).toBe(d2);
    });

    it('caches regardless of input order', () => {
        const d1 = buildConventionsDigest(['React.md', 'Universal.md']);
        const d2 = buildConventionsDigest(['Universal.md', 'React.md']);
        expect(d1).toBe(d2);
    });

    it('includes content from each requested file', () => {
        const digestUniversal = buildConventionsDigest(['Universal.md']);
        const digestReact = buildConventionsDigest(['React.md']);
        // Both should be non-empty (each file contributes headings)
        expect(digestUniversal.length).toBeGreaterThan(0);
        expect(digestReact.length).toBeGreaterThan(0);
    });
});

// ─── Test 5: Integration — prompt builders include conventions ───────────────

describe('Integration: prompt builders', () => {
    const testConventionFiles = ['Universal.md', 'React.md', 'TypeScript.md', 'JavaScript.md'];

    describe('buildDevPersona', () => {
        // Import lazily since persona.ts has the import already wired
        let buildDevPersona: typeof import('../src/agents/_shared/persona')['buildDevPersona'];

        beforeAll(async () => {
            const mod = await import('../src/agents/_shared/persona');
            buildDevPersona = mod.buildDevPersona;
        });

        it('includes <coding_conventions> block when conventionFiles provided', () => {
            const prompt = buildDevPersona({
                rank: 'senior',
                domain: 'frontend',
                languages: ['React', 'TypeScript'],
                tag: 'dev-senior-frontend-react',
                conventionFiles: testConventionFiles,
            });
            expect(prompt).toContain('<coding_conventions>');
            expect(prompt).toContain('</coding_conventions>');
            // In digest mode, individual file paths are not listed; the digest
            // contains extracted headings/rules and a .conventions/*.md escape hatch.
            // In fallback mode, individual .conventions/ paths are listed.
            const hasDigestEscapeHatch = prompt.includes('.conventions/*.md');
            const hasIndividualPaths = prompt.includes('.conventions/React.md');
            expect(hasDigestEscapeHatch || hasIndividualPaths).toBe(true);
        });

        it('does NOT include conventions instruction block when conventionFiles omitted', () => {
            const prompt = buildDevPersona({
                rank: 'junior',
                domain: 'backend',
                languages: ['Go'],
                tag: 'dev-junior-backend-go',
            });
            // The workflow step 2.5 references <coding_conventions> as text,
            // but the actual instruction block with "MUST read" should be absent.
            expect(prompt).not.toContain('BEFORE writing any code, you MUST read');
            expect(prompt).not.toContain('.conventions/');
        });

        it('does NOT include conventions instruction block when conventionFiles is empty', () => {
            const prompt = buildDevPersona({
                rank: 'junior',
                domain: 'backend',
                languages: ['Go'],
                tag: 'dev-junior-backend-go',
                conventionFiles: [],
            });
            expect(prompt).not.toContain('BEFORE writing any code, you MUST read');
            expect(prompt).not.toContain('.conventions/');
        });

        it('includes convention-reading instruction in workflow or conventions block', () => {
            const prompt = buildDevPersona({
                rank: 'principal',
                domain: 'fullstack',
                languages: ['React', 'Node.js'],
                tag: 'dev-principal-fullstack',
                conventionFiles: testConventionFiles,
            });
            // In compact mode the step 2.5 is removed but conventions are still referenced
            // via the <coding_conventions> block. In non-compact mode, step 2.5 exists.
            const hasStep25 = prompt.includes('2.5.');
            const hasConventionsBlock = prompt.includes('<coding_conventions>');
            expect(hasStep25 || hasConventionsBlock).toBe(true);
        });

        it('positions conventions block between </critical_rules> and <workflow>', () => {
            const prompt = buildDevPersona({
                rank: 'senior',
                domain: 'frontend',
                languages: ['React'],
                tag: 'dev-senior-frontend-react',
                conventionFiles: testConventionFiles,
            });
            const criticalEnd = prompt.indexOf('</critical_rules>');
            const conventionsStart = prompt.indexOf('<coding_conventions>');
            const workflowStart = prompt.indexOf('<workflow>');
            expect(criticalEnd).toBeLessThan(conventionsStart);
            expect(conventionsStart).toBeLessThan(workflowStart);
        });
    });

    describe('buildReviewerPersona', () => {
        let buildReviewerPersona: typeof import('../src/agents/_shared/persona')['buildReviewerPersona'];

        beforeAll(async () => {
            const mod = await import('../src/agents/_shared/persona');
            buildReviewerPersona = mod.buildReviewerPersona;
        });

        it('includes reviewer-specific conventions block when conventionFiles provided', () => {
            const prompt = buildReviewerPersona({
                rank: 'senior',
                domain: 'backend',
                languages: ['Go'],
                tag: 'reviewer-senior-backend-go',
                conventionFiles: ['Universal.md', 'Go.md'],
            });
            expect(prompt).toContain('<coding_conventions>');
            expect(prompt).toContain('</coding_conventions>');
            expect(prompt).toContain('.conventions/Go.md');
            expect(prompt).toContain('.conventions/Universal.md');
            expect(prompt).toContain('CHECK that the reviewed code follows these conventions');
            expect(prompt).toContain("severity 'major'");
        });

        it('does NOT include <coding_conventions> when conventionFiles omitted', () => {
            const prompt = buildReviewerPersona({
                rank: 'junior',
                domain: 'frontend',
                languages: ['React'],
                tag: 'reviewer-junior-frontend-react',
            });
            expect(prompt).not.toContain('<coding_conventions>');
        });

        it('positions conventions block between </identity> and <mission>', () => {
            const prompt = buildReviewerPersona({
                rank: 'senior',
                domain: 'backend',
                languages: ['Go'],
                tag: 'reviewer-senior-backend-go',
                conventionFiles: ['Universal.md', 'Go.md'],
            });
            const identityEnd = prompt.indexOf('</identity>');
            const conventionsStart = prompt.indexOf('<coding_conventions>');
            const missionStart = prompt.indexOf('<mission>');
            expect(identityEnd).toBeLessThan(conventionsStart);
            expect(conventionsStart).toBeLessThan(missionStart);
        });
    });

    describe('buildQaUnitPrompt', () => {
        let buildQaUnitPrompt: typeof import('../src/agents/qa/qa-unit.prompt')['buildQaUnitPrompt'];

        beforeAll(async () => {
            const mod = await import('../src/agents/qa/qa-unit.prompt');
            buildQaUnitPrompt = mod.buildQaUnitPrompt;
        });

        it('includes <coding_conventions> when conventionFiles provided', () => {
            const prompt = buildQaUnitPrompt(testConventionFiles);
            expect(prompt).toContain('<coding_conventions>');
            // In digest mode: escape-hatch glob; in fallback mode: individual paths
            const hasDigest = prompt.includes('.conventions/*.md');
            const hasPath = prompt.includes('.conventions/React.md');
            expect(hasDigest || hasPath).toBe(true);
        });

        it('does NOT include <coding_conventions> when called without args', () => {
            const prompt = buildQaUnitPrompt();
            expect(prompt).not.toContain('<coding_conventions>');
        });

        it('positions conventions block between </critical_rules> and <maintain_mode>', () => {
            const prompt = buildQaUnitPrompt(testConventionFiles);
            const criticalEnd = prompt.indexOf('</critical_rules>');
            const conventionsStart = prompt.indexOf('<coding_conventions>');
            const maintainStart = prompt.indexOf('<maintain_mode>');
            expect(criticalEnd).toBeLessThan(conventionsStart);
            expect(conventionsStart).toBeLessThan(maintainStart);
        });
    });

    describe('buildQaE2ePrompt', () => {
        let buildQaE2ePrompt: typeof import('../src/agents/qa/qa-e2e.prompt')['buildQaE2ePrompt'];

        beforeAll(async () => {
            const mod = await import('../src/agents/qa/qa-e2e.prompt');
            buildQaE2ePrompt = mod.buildQaE2ePrompt;
        });

        it('includes <coding_conventions> when conventionFiles provided', () => {
            const prompt = buildQaE2ePrompt(testConventionFiles);
            expect(prompt).toContain('<coding_conventions>');
            // In digest mode: escape-hatch glob; in fallback mode: individual paths
            const hasDigest = prompt.includes('.conventions/*.md');
            const hasPath = prompt.includes('.conventions/Universal.md');
            expect(hasDigest || hasPath).toBe(true);
        });

        it('does NOT include <coding_conventions> when called without args', () => {
            const prompt = buildQaE2ePrompt();
            expect(prompt).not.toContain('<coding_conventions>');
        });

        it('positions conventions block between </critical_rules> and <maintain_mode>', () => {
            const prompt = buildQaE2ePrompt(testConventionFiles);
            const criticalEnd = prompt.indexOf('</critical_rules>');
            const conventionsStart = prompt.indexOf('<coding_conventions>');
            const maintainStart = prompt.indexOf('<maintain_mode>');
            expect(criticalEnd).toBeLessThan(conventionsStart);
            expect(conventionsStart).toBeLessThan(maintainStart);
        });
    });

    describe('buildDevOpsPrompt', () => {
        let buildDevOpsPrompt: typeof import('../src/agents/devops/devops.prompt')['buildDevOpsPrompt'];

        beforeAll(async () => {
            const mod = await import('../src/agents/devops/devops.prompt');
            buildDevOpsPrompt = mod.buildDevOpsPrompt;
        });

        it('includes <coding_conventions> when conventionFiles provided', () => {
            const prompt = buildDevOpsPrompt(testConventionFiles);
            expect(prompt).toContain('<coding_conventions>');
            // In digest mode: escape-hatch glob; in fallback mode: individual paths
            const hasDigest = prompt.includes('.conventions/*.md');
            const hasPath = prompt.includes('.conventions/TypeScript.md');
            expect(hasDigest || hasPath).toBe(true);
        });

        it('does NOT include <coding_conventions> when called without args', () => {
            const prompt = buildDevOpsPrompt();
            expect(prompt).not.toContain('<coding_conventions>');
        });

        it('positions conventions block between </critical_rules> and <workflow>', () => {
            const prompt = buildDevOpsPrompt(testConventionFiles);
            const criticalEnd = prompt.indexOf('</critical_rules>');
            const conventionsStart = prompt.indexOf('<coding_conventions>');
            const workflowStart = prompt.indexOf('<workflow>');
            expect(criticalEnd).toBeLessThan(conventionsStart);
            expect(conventionsStart).toBeLessThan(workflowStart);
        });
    });

    describe('backward-compatible constant exports', () => {
        it('qaUnitSystemPrompt is defined and does not include conventions', async () => {
            const { qaUnitSystemPrompt } = await import('../src/agents/qa/qa-unit.prompt');
            expect(typeof qaUnitSystemPrompt).toBe('string');
            expect(qaUnitSystemPrompt.length).toBeGreaterThan(0);
            expect(qaUnitSystemPrompt).not.toContain('<coding_conventions>');
        });

        it('qaE2eSystemPrompt is defined and does not include conventions', async () => {
            const { qaE2eSystemPrompt } = await import('../src/agents/qa/qa-e2e.prompt');
            expect(typeof qaE2eSystemPrompt).toBe('string');
            expect(qaE2eSystemPrompt.length).toBeGreaterThan(0);
            expect(qaE2eSystemPrompt).not.toContain('<coding_conventions>');
        });

        it('devopsSystemPrompt is defined and does not include conventions', async () => {
            const { devopsSystemPrompt } = await import('../src/agents/devops/devops.prompt');
            expect(typeof devopsSystemPrompt).toBe('string');
            expect(devopsSystemPrompt.length).toBeGreaterThan(0);
            expect(devopsSystemPrompt).not.toContain('<coding_conventions>');
        });
    });

    describe('end-to-end: resolved files match deployed files in prompts', () => {
        let tempDir: string;

        beforeEach(() => {
            tempDir = createTempWorkspace();
        });

        afterEach(() => {
            cleanupTempWorkspace(tempDir);
        });

        it('convention files resolved for a React dev exist in workspace after deployment', () => {
            // Resolve convention files for a React developer
            const files = resolveConventionFiles(['React']);
            expect(files.length).toBeGreaterThan(0);

            // Deploy them
            const deployed = deployConventionsToWorkspace(tempDir, files);

            // Verify every resolved file was deployed
            for (const fileName of files) {
                const relativePath = `.conventions/${fileName}`;
                expect(deployed).toContain(relativePath);
                expect(fs.existsSync(path.join(tempDir, relativePath))).toBe(true);
            }

            // Verify the prompt references conventions in some form
            const instructions = getConventionReadInstructions(files);
            // In digest mode, the escape-hatch glob is present;
            // in fallback mode, individual file paths are listed.
            const hasDigestRef = instructions.includes('.conventions/*.md');
            const hasAllPaths = files.every((f) => instructions.includes(`.conventions/${f}`));
            expect(hasDigestRef || hasAllPaths).toBe(true);
        });

        it('convention files resolved from tech stack exist in workspace after deployment', () => {
            const techStack = [
                { layer: 'backend', choice: 'Go', alternatives: [], rationale: '' },
                { layer: 'frontend', choice: 'Angular', alternatives: [], rationale: '' },
            ];
            const files = resolveConventionFiles([], techStack);

            // Deploy the resolved files
            deployConventionsToWorkspace(tempDir, files);

            // Verify every resolved file is available
            for (const fileName of files) {
                expect(fs.existsSync(path.join(tempDir, '.conventions', fileName))).toBe(true);
            }
        });
    });
});
