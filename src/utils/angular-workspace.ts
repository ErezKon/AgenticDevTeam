/**
 * angular.json lookups (Plan 30-03): the test runner reads the `test` target
 * (Karma builder, karma config), the smoke test the `build` target's
 * `outputPath`.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface AngularTarget {
    builder?: string;
    options?: Record<string, unknown>;
}

/**
 * A target of the workspace's default project (else the first project that
 * has it), under `architect` or `targets`. Null without a readable angular.json.
 */
export function readAngularTarget(rootDir: string, target: string): AngularTarget | null {
    let workspace: any;
    try {
        workspace = JSON.parse(fs.readFileSync(path.join(rootDir, 'angular.json'), 'utf-8'));
    } catch {
        return null;
    }
    const projects: Record<string, any> = workspace?.projects ?? {};
    const names = [workspace?.defaultProject, ...Object.keys(projects)]
        .filter((name): name is string => typeof name === 'string' && !!projects[name]);
    for (const name of names) {
        const found = (projects[name].architect ?? projects[name].targets)?.[target];
        if (found && typeof found === 'object') return found as AngularTarget;
    }
    return null;
}
