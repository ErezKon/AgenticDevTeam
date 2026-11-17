/**
 * Plan 30-03 steps 5–6 — a salvaged worktree is never a product root, and the
 * smoke test serves the directory that actually holds index.html.
 *
 * claudeopus5: `.worktrees-failed/…` became a second product root, and the smoke
 * test served `dist/` of an Angular 17 build that writes `dist/<project>/browser/`
 * ("server did not become ready within 60000ms").
 */
jest.mock('../src/utils/logger');
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    PRODUCT_SMOKE_TIMEOUT_MS: 5000,
}));

import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { detectStackRoots } from '../src/conductor/quality-gates';
import { verifyBuildArtifacts, runSmokeTest } from '../src/conductor/product-verify';
import { angularOutputDirs, findIndexDir, findWebRoot, resolveServeDir } from '../src/conductor/product-serve-dir';

let dir: string;
beforeEach(() => { dir = makeTempDir('serve-dir-'); });
afterEach(() => cleanupDir(dir));

function write(file: string, content: string | object): void {
    const abs = path.join(dir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
}

/** Larger than PRODUCT_MIN_ARTIFACT_BYTES. */
const BUNDLE = 'console.log("app");'.repeat(200);

const angularJson = (outputPath: unknown) => ({
    projects: { app: { architect: { build: { builder: '@angular-devkit/build-angular:application', options: { outputPath } } } } },
});

/** An Angular 17 workspace: the application builder wrote dist/app/browser. */
function angularApp(): void {
    write('package.json', { name: 'app', scripts: { build: 'ng build', test: 'ng test' } });
    write('angular.json', angularJson('dist/app'));
    write('src/index.html', '<app-root></app-root>');
    write('dist/app/browser/index.html', '<!doctype html><html><body><app-root></app-root><script src="main.js" type="module"></script></body></html>');
    write('dist/app/browser/main.js', BUNDLE);
    write('dist/app/3rdpartylicenses.txt', 'MIT');
}

describe('detectStackRoots — salvage directories (step 5)', () => {
    it('never treats a salvaged worktree as a product root', () => {
        write('package.json', { name: 'app' });
        write('.worktrees-failed/app-feature-us-027/package.json', { name: 'app' });
        write('.worktrees/_failed/app-feature-us-001/package.json', { name: 'app' });
        write('packages/api/package.json', { name: 'api' });

        expect(detectStackRoots(dir).map(r => r.relDir)).toEqual(['', path.join('packages', 'api')]);
    });
});

describe('serve directory (step 6)', () => {
    it('reads angular.json outputPath as a string or as { base, browser }', () => {
        write('angular.json', angularJson('dist/app'));
        expect(angularOutputDirs(dir)).toEqual([path.join('dist', 'app', 'browser'), 'dist/app']);
        write('angular.json', angularJson({ base: 'dist/app', browser: '' }));
        expect(angularOutputDirs(dir)).toEqual([path.join('dist', 'app')]);
        write('angular.json', { projects: { app: { targets: { build: { options: { outputPath: { base: 'out' } } } } } } });
        expect(angularOutputDirs(dir)).toEqual([path.join('out', 'browser')]);
    });

    it('serves the Angular browser directory, not dist/', () => {
        angularApp();
        expect(resolveServeDir(dir, path.join(dir, 'dist'))).toBe(path.join(dir, 'dist', 'app', 'browser'));
    });

    it('otherwise serves the shallowest directory under the build output that holds index.html', () => {
        write('dist/web/index.html', '<html></html>');
        write('dist/web/legacy/fallback/index.html', '<html></html>');
        expect(findIndexDir(path.join(dir, 'dist'))).toBe(path.join(dir, 'dist', 'web'));
        expect(resolveServeDir(dir, path.join(dir, 'dist'))).toBe(path.join(dir, 'dist', 'web'));
    });

    it('falls back to the build output itself when nothing in it holds index.html', () => {
        write('dist/assets/main.js', BUNDLE);
        expect(resolveServeDir(dir, path.join(dir, 'dist'))).toBe(path.join(dir, 'dist'));
    });
});

describe('runSmokeTest (step 6)', () => {
    it('serves dist/<project>/browser for an Angular build and passes', async () => {
        angularApp();
        const roots = detectStackRoots(dir);
        const artifacts = verifyBuildArtifacts(dir, roots);
        expect(artifacts[0]).toMatchObject({ passed: true, foundDir: 'dist' });
        expect(findWebRoot(roots, artifacts)?.serveDir).toBe(path.join(dir, 'dist', 'app', 'browser'));

        const smoke = await runSmokeTest(dir, roots, artifacts);

        expect(smoke).toMatchObject({ ran: true, passed: true, httpStatus: 200 });
        expect(smoke.reason).toContain(`served OK from ${path.join('dist', 'app', 'browser')}`);
    }, 15_000);

    it('reports what a 404 means instead of waiting for readiness until the timeout', async () => {
        write('package.json', { name: 'app', scripts: { build: 'vite build' } });
        write('vite.config.ts', 'export default {};');
        write('index.html', '<div id="root"></div>');
        write('dist/assets/main.js', BUNDLE);
        const roots = detectStackRoots(dir);
        const artifacts = verifyBuildArtifacts(dir, roots);

        const started = Date.now();
        const smoke = await runSmokeTest(dir, roots, artifacts);

        expect(smoke).toMatchObject({ ran: true, passed: false, httpStatus: 404 });
        expect(smoke.reason).toBe('GET / returned 404 — no index.html under dist');
        expect(Date.now() - started).toBeLessThan(4000);
    }, 15_000);
});
