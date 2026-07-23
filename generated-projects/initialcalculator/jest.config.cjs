/**
 * Jest configuration for a React + TypeScript project using ts-jest.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
      diagnostics: false,
    },
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    'react/jsx-runtime': '<rootDir>/src/__mocks__/react-jsx-runtime.js',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },
};