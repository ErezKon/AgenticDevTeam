const fs = require('fs');
const path = require('path');

describe('Responsive CSS for calculator', () => {
  test('styles.css contains media query for max-width 480px', () => {
    const cssPath = path.resolve(__dirname, '..', 'styles.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    expect(css).toMatch(/@media\s*\(max-width:\s*480px\)/);
    expect(css).toMatch(/grid-template-columns:\s*1fr/);
    expect(css).toMatch(/min-height:\s*48px/);
  });
});
