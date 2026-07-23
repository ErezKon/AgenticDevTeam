// Mock for @octokit/rest used in tests
module.exports = {
  Octokit: class {
    constructor() {}
    request() {
      return Promise.resolve({ data: {} });
    }
  },
};