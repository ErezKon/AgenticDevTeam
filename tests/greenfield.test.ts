/**
 * Greenfield Autonomous Flow — integration tests.
 *
 * For each spec file in specs/new/, runs a full autonomous pipeline
 * and asserts that the final state contains all expected outputs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runAutonomous } from '../src/conductor/run';
import { discoverSpecs, findGeneratedProject } from './utils';

const SPECS_NEW_DIR = path.resolve(__dirname, '..', 'specs', 'new');
const specs = discoverSpecs(SPECS_NEW_DIR);

describe('Greenfield Autonomous Flow', () => {
    if (specs.length === 0) {
        it('should have at least one spec file in specs/new/', () => {
            throw new Error(`No spec files found in ${SPECS_NEW_DIR}`);
        });
        return;
    }

    for (const spec of specs) {
        describe(`System: ${spec.systemName}`, () => {
            it(`should complete full autonomous pipeline for ${spec.systemName}`, async () => {
                const finalState = await runAutonomous({
                    systemName: spec.systemName,
                    requirementsDocPath: spec.filePath,
                    mode: 'autonomous',
                    runType: 'greenfield',
                });

                // Pipeline should reach finalize phase
                expect(finalState.phase).toBe('finalize');

                // Workspace should exist on disk
                expect(finalState.workspacePath).toBeTruthy();
                expect(fs.existsSync(finalState.workspacePath)).toBe(true);

                // Architecture should be produced
                expect(finalState.architecture).not.toBeNull();

                // PM outputs
                expect(finalState.userStories.length).toBeGreaterThan(0);
                expect(finalState.tasks.length).toBeGreaterThan(0);

                // Team leader assignments
                expect(finalState.assignments.length).toBeGreaterThan(0);

                // Developer outputs
                expect(finalState.fileChanges.length).toBeGreaterThan(0);

                // QA outputs
                expect(finalState.testReports.length).toBeGreaterThan(0);

                // Artifacts and transcript
                expect(finalState.artifacts.length).toBeGreaterThan(0);
                expect(finalState.transcript.length).toBeGreaterThan(0);
            });
        });
    }
});
