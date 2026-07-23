// Global mocks for problematic modules
jest.mock('@octokit/rest', () => {
  // Provide a minimal mock implementation
  class Octokit {
    constructor() {}
    // Add any methods used in tests as no-ops
    request() {
      return Promise.resolve({ data: {} });
    }
  }
  return { Octokit };
});
