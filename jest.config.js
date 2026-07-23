/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    setupFiles: ['<rootDir>/tests/setup.ts'],
    testTimeout: 900_000, // 15 min default for LLM-heavy integration tests
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
        '^.+\\.jsx?$': ['ts-jest', { tsconfig: { allowJs: true } }],
    },
    transformIgnorePatterns: [
        'node_modules/(?!(@octokit|universal-user-agent|before-after-hook)/)',
    ],
};
