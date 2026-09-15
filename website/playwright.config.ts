import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    baseURL: 'http://127.0.0.1:4173/gsharp/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run serve -- --host 127.0.0.1 --port 4173 --no-open',
    url: 'http://127.0.0.1:4173/gsharp/',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [
    {name: 'chromium', testMatch: 'site.spec.ts', use: {...devices['Desktop Chrome']}},
    {name: 'webkit', testMatch: 'site.spec.ts', use: {...devices['Desktop Safari']}},
    {name: 'firefox', testMatch: 'site.spec.ts', use: {...devices['Desktop Firefox']}},
    {
      name: 'visual-chromium',
      testMatch: 'visual.spec.ts',
      use: {...devices['Desktop Chrome'], deviceScaleFactor: 1},
    },
  ],
});
