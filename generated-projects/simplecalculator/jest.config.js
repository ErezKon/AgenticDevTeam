module.exports = {
  testEnvironment: 'jsdom',
  transform: {
    '^.+\\.(ts|tsx)$': 'babel-jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  testMatch: ['**/src/**/*.test.{ts,tsx}'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/'],
  transformIgnorePatterns: ['/node_modules/(?!@octokit)'],
  moduleNameMapper: {
    '^@octokit/rest$': '<rootDir>/__mocks__/octokitRestMock.js',
  },
};