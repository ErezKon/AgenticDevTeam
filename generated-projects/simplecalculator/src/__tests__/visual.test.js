const fs = require('fs');
const path = require('path');

jest.setTimeout(60000);

describe('Visual regression - mobile viewport', () => {
  beforeAll(async () => {
    // Set mobile viewport size
    await page.setViewport({ width: 375, height: 667 });
    // Load CSS
    const css = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
    // Simple static markup representing calculator layout
    const htmlContent = `
      <style>${css}</style>
      <div class="calculator">
        <div class="display">
          <div class="expression" data-testid="expression">12+34</div>
          <div class="result" data-testid="result">46</div>
        </div>
        <div class="keypad" role="grid">
          <button class="key">1</button>
          <button class="key">2</button>
          <button class="key">+</button>
          <button class="key">=</button>
        </div>
      </div>
    `;
    await page.setContent(htmlContent);
    await page.waitForSelector('.calculator');
    
  });

  it('matches the mobile layout snapshot', async () => {
    const calculator = await page.$('.calculator');
    const image = await calculator.screenshot();
    expect(image).toMatchImageSnapshot({
      customSnapshotIdentifier: 'mobile-calculator',
    });
  });
});
