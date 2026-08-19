/**
 * Assembly Gate -- unit tests for runAssemblyGate, buildAssemblyAssignment,
 * and assemblyGateOutcome.
 *
 * Verifies that the assembly gate correctly detects missing entry points,
 * unwired modules, and missing static assets, and that the outcome adapter
 * produces well-formed GateOutcome objects.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    runAssemblyGate,
    buildAssemblyAssignment,
    assemblyGateOutcome,
} from '../src/conductor/assembly-gate';
import type { AssemblyGateResult } from '../src/conductor/assembly-gate';
import { walkDir } from '../src/utils/fs-walk';

// ---- Mocks ------------------------------------------------------------------

jest.mock('fs');
jest.mock('../src/utils/fs-walk', () => ({
    walkDir: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
}));

const mockExistsSync = fs.existsSync as jest.Mock;
const mockReadFileSync = fs.readFileSync as jest.Mock;
const mockWalkDir = walkDir as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
});

// ---- buildAssemblyAssignment (pure function) --------------------------------

describe('buildAssemblyAssignment', () => {
    it('returns an Assignment with id ASSEMBLY-001', () => {
        const assignment = buildAssemblyAssignment(['icon.png'], ['auth'], 'my-app');
        expect(assignment.id).toBe('ASSEMBLY-001');
    });

    it('has correct branchName based on projectSlug', () => {
        const assignment = buildAssemblyAssignment([], [], 'cool-project');
        expect(assignment.branchName).toBe('cool-project/chore/assembly');
    });

    it('has priority critical and taskType chore', () => {
        const assignment = buildAssemblyAssignment([], [], 'proj');
        expect(assignment.priority).toBe('critical');
        expect(assignment.taskType).toBe('chore');
    });

    it('description includes missing assets and unwired modules', () => {
        const assignment = buildAssemblyAssignment(
            ['favicon.ico', 'logo.png'],
            ['auth-module', 'db-module'],
            'proj',
        );
        expect(assignment.description).toContain('favicon.ico');
        expect(assignment.description).toContain('logo.png');
        expect(assignment.description).toContain('auth-module');
        expect(assignment.description).toContain('db-module');
    });

    it('empty arrays produce a clean description without missing/unwired lines', () => {
        const assignment = buildAssemblyAssignment([], [], 'proj');
        expect(assignment.description).not.toContain('Missing referenced assets');
        expect(assignment.description).not.toContain('Unwired modules');
        // Still contains the general instructions
        expect(assignment.description).toContain('ASSEMBLY TASK');
    });
});

// ---- runAssemblyGate (requires fs mocks) ------------------------------------

describe('runAssemblyGate', () => {
    const workspace = '/tmp/test-workspace';

    it('passes when entry point exists with imports and no missing assets', () => {
        // walkDir finds no HTML files (so no missing assets)
        mockWalkDir.mockImplementation(() => {});

        // Entry point exists and has imports
        mockExistsSync.mockImplementation((p: string) => {
            return p === path.join(workspace, 'src/main.ts');
        });
        mockReadFileSync.mockImplementation((p: string) => {
            if (p === path.join(workspace, 'src/main.ts')) {
                return "import { AppModule } from './app.module';\nimport { bootstrap } from './bootstrap';";
            }
            return '';
        });

        const result = runAssemblyGate(workspace);

        expect(result.passed).toBe(true);
        expect(result.missingAssets).toEqual([]);
        expect(result.unwiredModules).toEqual([]);
        expect(result.summary).toContain('passed');
    });

    it('fails when no entry point found', () => {
        mockWalkDir.mockImplementation(() => {});
        mockExistsSync.mockReturnValue(false);

        const result = runAssemblyGate(workspace);

        expect(result.passed).toBe(false);
        expect(result.summary).toContain('No entry point found');
    });

    it('fails when entry point has no imports and is not index.html', () => {
        mockWalkDir.mockImplementation(() => {});

        mockExistsSync.mockImplementation((p: string) => {
            return p === path.join(workspace, 'src/main.ts');
        });
        mockReadFileSync.mockImplementation((p: string) => {
            if (p === path.join(workspace, 'src/main.ts')) {
                return '// empty file with no imports\nconsole.log("hello");';
            }
            return '';
        });

        const result = runAssemblyGate(workspace);

        expect(result.passed).toBe(false);
        expect(result.unwiredModules.length).toBeGreaterThan(0);
        expect(result.summary).toContain('no imports');
    });

    it('index.html entry point passes even with no imports', () => {
        mockWalkDir.mockImplementation(() => {});

        // None of the src/* candidates exist, only index.html
        mockExistsSync.mockImplementation((p: string) => {
            return p === path.join(workspace, 'index.html');
        });
        mockReadFileSync.mockImplementation((p: string) => {
            if (p === path.join(workspace, 'index.html')) {
                return '<html><body><h1>Hello</h1></body></html>';
            }
            return '';
        });

        const result = runAssemblyGate(workspace);

        expect(result.passed).toBe(true);
        expect(result.unwiredModules).toEqual([]);
    });

    it('reports missing assets when HTML refs nonexistent files', () => {
        // walkDir emits an HTML file
        mockWalkDir.mockImplementation(
            (_root: string, _base: string, cb: (relPath: string) => void) => {
                cb('index.html');
            },
        );

        // Entry point exists with imports so entry check passes
        mockExistsSync.mockImplementation((p: string) => {
            if (p === path.join(workspace, 'src/main.ts')) return true;
            // The HTML file itself exists
            if (p === path.join(workspace, 'index.html')) return true;
            // The referenced asset does NOT exist anywhere
            return false;
        });

        mockReadFileSync.mockImplementation((p: string) => {
            if (p === path.join(workspace, 'src/main.ts')) {
                return "import { App } from './App';";
            }
            if (p === path.join(workspace, 'index.html')) {
                return '<html><head><link href="favicon.ico"></head></html>';
            }
            return '';
        });

        const result = runAssemblyGate(workspace);

        expect(result.passed).toBe(false);
        expect(result.missingAssets.length).toBeGreaterThan(0);
        expect(result.summary).toContain('missing');
    });
});

// ---- assemblyGateOutcome (pure function) ------------------------------------

describe('assemblyGateOutcome', () => {
    it('passing result produces status=pass, empty findings, empty bugs', () => {
        const result: AssemblyGateResult = {
            passed: true,
            missingAssets: [],
            unwiredModules: [],
            summary: 'Assembly gate passed',
        };

        const outcome = assemblyGateOutcome(result);

        expect(outcome.status).toBe('pass');
        expect(outcome.findings).toEqual([]);
        expect(outcome.bugs).toEqual([]);
        expect(outcome.gate).toBe('assembly');
    });

    it('missing assets produce a major severity finding and a bug', () => {
        const result: AssemblyGateResult = {
            passed: false,
            missingAssets: ['favicon.ico', 'logo.png'],
            unwiredModules: [],
            summary: 'Assembly gate FAILED',
        };

        const outcome = assemblyGateOutcome(result);

        expect(outcome.status).toBe('fail');
        expect(outcome.findings).toHaveLength(1);
        expect(outcome.findings[0].severity).toBe('major');
        expect(outcome.findings[0].id).toBe('ASSEMBLY-MISSING-ASSETS');
        expect(outcome.bugs).toHaveLength(1);
        expect(outcome.bugs[0].severity).toBe('major');
    });

    it('unwired modules produce a critical severity finding and a bug', () => {
        const result: AssemblyGateResult = {
            passed: false,
            missingAssets: [],
            unwiredModules: ['(entry point has no imports)'],
            summary: 'Assembly gate FAILED',
        };

        const outcome = assemblyGateOutcome(result);

        expect(outcome.status).toBe('fail');
        expect(outcome.findings).toHaveLength(1);
        expect(outcome.findings[0].severity).toBe('critical');
        expect(outcome.findings[0].id).toBe('ASSEMBLY-UNWIRED');
        expect(outcome.bugs).toHaveLength(1);
        expect(outcome.bugs[0].severity).toBe('critical');
    });

    it('gate name is assembly', () => {
        const result: AssemblyGateResult = {
            passed: true,
            missingAssets: [],
            unwiredModules: [],
            summary: 'ok',
        };
        expect(assemblyGateOutcome(result).gate).toBe('assembly');
    });
});
