/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    setupFiles: ['<rootDir>/tests/setup.ts'],
    setupFilesAfterFramework: ['<rootDir>/tests/setup-env-guard.ts'],
    testTimeout: 10_000,
    restoreMocks: true,
    testPathIgnorePatterns: [
        '/tests/fixtures/',
        'greenfield',
        'maintain',
        'oauth',
        'pipeline-replay',
    ],
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
        '^.+\\.jsx?$': ['ts-jest', { tsconfig: { allowJs: true } }],
    },
    transformIgnorePatterns: [
        'node_modules/(?!(@octokit|universal-user-agent|before-after-hook)/)',
    ],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/index.ts',
        '!src/cli.ts',
    ],
    coverageThreshold: {
        global: {
            lines: 25,
            branches: 20,
            functions: 20,
            statements: 25,
        },
    },
};
