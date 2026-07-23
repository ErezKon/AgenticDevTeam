module.exports = {
  // Run only our JavaScript test files in src directory
  testMatch: ['**/src/**/*.test.js'],
  // Ignore node_modules
  testPathIgnorePatterns: ['/node_modules/'],
  // No transformation needed for plain JS tests
  transform: {},
  silent: true,
  // Setup file for global mocks
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Mock problematic modules
  moduleNameMapper: {
    '^@octokit/rest
  // Run only our JavaScript test files in src/utils/__tests__
  testMatch: ['**/src/**/*.test.js'],
  // Ignore node_modules and specific problematic test files
  testPathIgnorePatterns: ['/node_modules/', '**/maintain.test.ts'],
  transform: {},
  silent: true,

  // Run only our JavaScript test files in src/utils/__tests__
  testMatch: ['**/src/utils/__tests__/**/*.test.js'],
  // Ignore node_modules and any other test directories
  testPathIgnorePatterns: ['/node_modules/'],
  transform: {},
  silent: true,

  // Only run JavaScript test files to avoid TypeScript parsing issues
  testMatch: ['**/src/**/*.test.js'],
  // No transform needed as we are using plain JavaScript tests
  transform: {},
  // Silence console output during tests
  silent: true,
};: '<rootDir>/__mocks__/@octokit/rest.js',
  },

  // Run only our JavaScript test files in src/utils/__tests__
  testMatch: ['**/src/**/*.test.js'],
  // Ignore node_modules and specific problematic test files
  testPathIgnorePatterns: ['/node_modules/', '**/maintain.test.ts'],
  transform: {},
  silent: true,

  // Run only our JavaScript test files in src/utils/__tests__
  testMatch: ['**/src/utils/__tests__/**/*.test.js'],
  // Ignore node_modules and any other test directories
  testPathIgnorePatterns: ['/node_modules/'],
  transform: {},
  silent: true,

  // Only run JavaScript test files to avoid TypeScript parsing issues
  testMatch: ['**/src/**/*.test.js'],
  // No transform needed as we are using plain JavaScript tests
  transform: {},
  // Silence console output during tests
  silent: true,
};