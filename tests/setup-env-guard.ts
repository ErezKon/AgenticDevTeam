/**
 * Jest setupFilesAfterFramework — snapshot and restore process.env around every test.
 *
 * Prevents env mutations in one test from leaking into subsequent tests,
 * which was a known source of cross-file pollution (15+ un-restored mutations).
 */
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
    envSnapshot = { ...process.env };
});

afterEach(() => {
    // Remove keys that were added during the test
    for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) {
            delete process.env[key];
        }
    }
    // Restore keys that were changed or deleted during the test
    for (const [key, value] of Object.entries(envSnapshot)) {
        if (process.env[key] !== value) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
});
