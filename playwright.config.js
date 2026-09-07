const { defineConfig, devices } = require('@playwright/test');
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

// Some minimal Linux hosts need the repository's libasound compatibility stub.
// Build it only when the helper exists; ordinary developer machines should use
// Playwright's normal browser/runtime discovery without depending on .claude.
const asoundStub = '/tmp/libasound.so.2';
const asoundBuilder = path.join(__dirname, '.claude/skills/run-pos-system/build-libasound-stub.mjs');
if (!existsSync(asoundStub) && existsSync(asoundBuilder)) {
  execSync(`node ${JSON.stringify(asoundBuilder)}`);
}

const launchOptions = {
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
};
if (process.env.POS_PLAYWRIGHT_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.POS_PLAYWRIGHT_EXECUTABLE_PATH;
}
if (existsSync(asoundStub)) {
  launchOptions.env = { ...process.env, LD_LIBRARY_PATH: '/tmp' };
}

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3001',
    viewport: { width: 1280, height: 800 },
    launchOptions,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node server.js',
    url: 'http://localhost:3001',
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
