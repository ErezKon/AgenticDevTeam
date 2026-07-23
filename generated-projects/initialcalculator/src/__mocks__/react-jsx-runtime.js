/**
 * Minimal mock for react/jsx-runtime to satisfy Jest's module resolution.
 * It provides the `jsx`, `jsxs`, and `Fragment` exports used by compiled JSX.
 */
module.exports.Fragment = "Fragment";
module.exports.jsx = function jsx(type, props, key) {
  return { type, props, key };
}
module.exports.jsxs = function jsxs(type, props, key) {
  return { type, props, key };
}
