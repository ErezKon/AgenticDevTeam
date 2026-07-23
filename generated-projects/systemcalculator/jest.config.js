module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['**/src/**/*.test.{ts,tsx,js,jsx}', '**/tests/**/*.test.{ts,tsx,js,jsx}'],
  testPathIgnorePatterns: ['/node_modules/'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  setupFiles: ['<rootDir>/jest.setup.js', '<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@octokit/rest$': '<rootDir>/__mocks__/@octokit/rest.js',
  },
  collectCoverage: true,
  silent: true,
};