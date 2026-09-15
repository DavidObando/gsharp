import {test, expect} from '@playwright/test';
import os from 'node:os';

test.beforeAll(() => {
  expect(
    process.platform,
    'Visual baselines use macOS 26 arm64, matching the dedicated CI job.',
  ).toBe('darwin');
  expect(process.arch).toBe('arm64');
  expect(os.release().split('.')[0]).toBe('25');
});

for (const colorScheme of ['light', 'dark'] as const) {
  for (const scenario of [
    {name: 'home', route: './', width: 1440, height: 1000},
    {name: 'swift', route: 'docs/bridges/gsharp-for-swift-developers', width: 390, height: 844},
    {name: 'concurrency', route: 'concurrency', width: 1440, height: 1000},
    {name: 'learn', route: 'learn', width: 390, height: 844},
    {name: 'install', route: 'docs/getting-started/install', width: 1440, height: 1000},
    {name: 'reference', route: 'docs/ref/spec', width: 1440, height: 1000},
    {name: 'search', route: 'docs/intro', width: 390, height: 844},
    {name: 'trail', route: 'trail', width: 1440, height: 1000},
    {name: 'kotlin', route: 'docs/bridges/gsharp-for-kotlin-developers', width: 390, height: 844},
  ]) {
    test(`${scenario.name} ${colorScheme}`, async ({page}) => {
      await page.emulateMedia({colorScheme, reducedMotion: 'reduce'});
      await page.setViewportSize({width: scenario.width, height: scenario.height});
      await page.goto(scenario.route);
      await expect(page.locator('html')).toHaveAttribute('data-has-hydrated', 'true');
      await page.evaluate(() => document.fonts.ready);
      if (scenario.name === 'search') {
        await page.getByRole('button', {name: 'Search documentation', exact: true}).click();
        await page.getByRole('searchbox').fill('GS0154');
        await expect(page.locator('.gs-search-result').first()).toBeVisible();
      }
      await expect(page).toHaveScreenshot(`${scenario.name}-${colorScheme}.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.002,
      });
    });
  }
}
