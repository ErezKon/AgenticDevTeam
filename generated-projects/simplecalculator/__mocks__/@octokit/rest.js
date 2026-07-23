// Manual mock for @octokit/rest to prevent ESM import errors during Jest tests.
module.exports = {
  Octokit: class {
    constructor() {}
    // Add any methods used in the codebase as no-ops.
    request() {
      return Promise.resolve({});
    }
  },
};
