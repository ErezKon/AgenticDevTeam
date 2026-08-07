module.exports = {
  root: true,
  env: {
    node: true,
    browser: true,
    es2021: true,
    'vitest/globals': true,
  },
  parser: 'vue-eslint-parser',
  parserOptions: {
    parser: '@typescript-eslint/parser',
    ecmaVersion: 2021,
    sourceType: 'module',
  },
  extends: [
    'plugin:vue/vue3-recommended',
    'plugin:@typescript-eslint/recommended',
    'eslint:recommended',
  ],
  plugins: ['vue', '@typescript-eslint'],
  rules: {
    // Add project-specific rules here
    'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    '@typescript-eslint/no-explicit-any': 'off',
  },
};