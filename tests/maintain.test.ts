/**
 * Maintain Autonomous Flow — integration tests.
 *
 * For each spec file in specs/existing/, runs a full autonomous pipeline
 * in maintain mode against a previously generated project directory
 * and asserts that the final state contains all expected outputs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runAutonomous } from '../src/conductor/run';
import { discoverSpecs, findGeneratedProject } from './utils';

const SPECS_EXISTING_DIR = path.resolve(__dirname, '..', 'specs', 'existing');
const specs = discoverSpecs(SPECS_EXISTING_DIR);

describe('Maintain Autonomous Flow', () => {
    if (specs.length === 0) {
        it('should have at least one spec file in specs/existing/', () => {
            throw new Error(`No spec files found in ${SPECS_EXISTING_DIR}`);
        });
        return;
    }

    for (const spec of specs) {
        describe(`System: ${spec.systemName}`, () => {
            let existingProjectPath: string;

            beforeAll(() => {
                // The maintain spec references an existing project.
                // By convention, the spec filename maps to a generated project.
                // e.g. "scientific-calculator.txt" targets the "SimpleCalculator" project
                // because the spec says "for the existing SimpleCalculator program".
                // We scan the spec content to find the referenced project name,
                // then fall back to using the spec's own system name.
                const specContent = fs.readFileSync(spec.filePath, 'utf-8');
                const match = specContent.match(/existing\s+(\w+)\s+program/i);
                const targetSystemName = match ? match[1] : spec.systemName;

                existingProjectPath = findGeneratedProject(targetSystemName);

                if (!fs.existsSync(existingProjectPath)) {
                    throw new Error(
                        `Generated project not found at ${existingProjectPath}. ` +
                        `Run greenfield tests first to create it.`
                    );
                }
            });

            it(`should complete maintain pipeline for ${spec.systemName}`, async () => {
                const finalState = await runAutonomous({
                    systemName: spec.systemName,
                    requirementsDocPath: spec.filePath,
                    mode: 'autonomous',
                    runType: 'maintain',
                    existingProjectPath,
                });

                // Pipeline should reach finalize phase
                expect(finalState.phase).toBe('finalize');

                // Workspace should match the existing project path
                expect(finalState.workspacePath).toBe(existingProjectPath);

                // Codebase analysis should be produced (maintain mode only)
                expect(finalState.codebaseAnalysis).not.toBeNull();

                // Developer outputs — new/modified files
                expect(finalState.fileChanges.length).toBeGreaterThan(0);

                // QA outputs
                expect(finalState.testReports.length).toBeGreaterThan(0);

                // Artifacts
                expect(finalState.artifacts.length).toBeGreaterThan(0);
            });
        });
    }
});
