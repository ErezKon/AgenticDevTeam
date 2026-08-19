/**
 * Tests for resolveWorkspacePath -- security-critical path resolution.
 *
 * Ensures workspace-relative paths cannot escape the workspace root
 * via traversal, absolute paths, or prefix collisions.
 */
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
    logToolAction: jest.fn(),
}));
jest.mock('../src/utils/log-colors.util', () => ({
    LogColors: { bg256: jest.fn((_: number, s: string) => s) },
}));
jest.mock('../src/config', () => ({
    GENERATED_PROJECTS_DIR: '/tmp/generated-projects',
    OUTPUTS_DIR: '/tmp/outputs',
    AGENT_ARTIFACTS_IN_REPO: false,
}));

import { resolveWorkspacePath } from '../src/utils/workspace';

describe('resolveWorkspacePath', () => {
    it('resolves a normal relative path within the workspace', () => {
        const result = resolveWorkspacePath('/workspace/proj', 'src/main.ts');
        expect(result).toBe('/workspace/proj/src/main.ts');
    });

    it('throws on path traversal with ".."', () => {
        expect(() =>
            resolveWorkspacePath('/workspace/proj', '../../../etc/passwd'),
        ).toThrow('Path escape detected');
    });

    it('throws on absolute path escape', () => {
        expect(() =>
            resolveWorkspacePath('/workspace/proj', '/etc/passwd'),
        ).toThrow('Path escape detected');
    });

    it('strips doubled generated-projects prefix', () => {
        const result = resolveWorkspacePath(
            '/tmp/generated-projects/myapp',
            'generated-projects/myapp/src/main.ts',
        );
        expect(result).toBe('/tmp/generated-projects/myapp/src/main.ts');
    });

    it('is safe against prefix collisions (app vs app-evil)', () => {
        expect(() =>
            resolveWorkspacePath('/workspace/app', '../app-evil/x'),
        ).toThrow('Path escape detected');
    });

    it('resolves nested relative paths correctly', () => {
        const result = resolveWorkspacePath('/workspace/proj', 'src/components/Button.tsx');
        expect(result).toBe('/workspace/proj/src/components/Button.tsx');
    });

    it('resolves dot path to the workspace root', () => {
        const result = resolveWorkspacePath('/workspace/proj', '.');
        expect(result).toBe('/workspace/proj');
    });

    it('resolves empty relative path to the workspace root', () => {
        const result = resolveWorkspacePath('/workspace/proj', '');
        expect(result).toBe('/workspace/proj');
    });
});
