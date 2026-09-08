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

const disposableCertification = process.env.POS_DISPOSABLE_CERTIFICATION === 'YES';
const baseURL = String(process.env.POS_TEST_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
// A disposable run may set POS_TEST_BASE_URL to its own dynamically selected
// loopback port. That is still a locally owned server, not an external target.
const externalServer = Boolean(process.env.POS_TEST_BASE_URL) && !disposableCertification;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    launchOptions,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Local/disposable certification owns its native POS server. An explicit
  // POS_TEST_BASE_URL only suppresses webServer startup for non-disposable runs
  // such as a pre-existing staging/candidate host. Disposable certification
  // never reuses a running process, regardless of which free loopback port it
  // selected.
  webServer: externalServer ? undefined : {
    command: 'node server.js',
    url: baseURL,
    reuseExistingServer: disposableCertification ? false : true,
    timeout: 15_000,
  },
});
