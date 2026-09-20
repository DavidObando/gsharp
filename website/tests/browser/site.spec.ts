import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import rawBenchmark from '../../static/data/concurrency-bench.json';
import type {Snapshot} from '../../src/components/ConcurrencyBenchmarks';

const benchmark: Snapshot = rawBenchmark;

test('home, examples, and primary navigation', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await expect(page.getByRole('heading', {level: 1})).toContainText('A fresh way');
  await expect(page.getByRole('link', {name: 'Get started', exact: true})).toHaveAttribute(
    'href',
    '/gsharp/docs/getting-started/install',
  );
  await page.getByRole('tab', {name: 'Structured concurrency', exact: true}).click();
  await expect(page.getByRole('tabpanel')).toContainText('Start together. Finish together.');
  await expect(page.getByRole('tabpanel')).toContainText('42');
  await page.getByRole('tab', {name: '.NET libraries', exact: true}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', {name: 'Structured concurrency', exact: true})).toBeFocused();
  for (const [route, destination] of [
    ['learn', '/gsharp/docs/tutorials/trail'],
    ['reference', '/gsharp/docs/ref/quick-reference'],
    ['tooling', '/gsharp/trail'],
    ['project', 'https://github.com/DavidObando/Oahu'],
  ]) {
    await page.goto(route);
    await expect(page.getByRole('heading', {level: 1})).toBeVisible();
    await expect(page.locator(`main a[href="${destination}"]`).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('Next article links keep the development version', async ({page}) => {
  await page.goto('docs/next/intro');
  await expect(page.getByRole('link', {name: 'Learn', exact: true})).toHaveClass(
    /navbar__link--active/,
  );
  await page.locator('article').getByRole('link', {name: 'Install G#', exact: true}).click();
  await expect(page).toHaveURL(/\/docs\/next\/getting-started\/install/);
  await page
    .locator('article')
    .getByRole('link', {name: 'Quickstart: Hello, G#', exact: true})
    .click();
  await expect(page).toHaveURL(/\/docs\/next\/getting-started\/quickstart/);
});

test('local search is lazy, version-aware, and keyboard accessible', async ({page}) => {
  const indexRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/pagefind/')) indexRequests.push(request.url());
  });
  await page.goto('docs/next/intro');
  await expect(page.locator('html')).toHaveAttribute('data-has-hydrated', 'true');
  expect(indexRequests).toEqual([]);
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox')).toHaveValue('current');
  const input = dialog.getByRole('searchbox');
  await expect(input).toBeVisible();
  await input.fill('GS0154');
  await expect(dialog.locator('.gs-search-result')).not.toHaveCount(0);
  await expect(dialog.locator('.gs-search-result').first()).toContainText('Next');
  await expect(
    dialog.locator(
      '.gs-search-result > a:not(.gs-search-section)[href*="/docs/next/ref/diagnostics"]',
    ),
  ).toBeAttached();
  await dialog.getByRole('combobox').selectOption('0.4');
  await expect(dialog.getByRole('searchbox')).toHaveValue('GS0154');
  await expect(dialog.locator('.gs-search-result')).not.toHaveCount(0);
  await expect(dialog.locator('.gs-search-result a[href*="/docs/next/"]')).toHaveCount(0);
  await dialog.getByRole('button', {name: '?. safe access', exact: true}).click();
  await expect(dialog.getByRole('searchbox')).toHaveValue('null conditional access');
  await expect(dialog.locator('.gs-search-result')).not.toHaveCount(0);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({colorScheme});
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    await expect(dialog).toHaveAttribute('data-pf-theme', colorScheme);
    const accessibility = await new AxeBuilder({page})
      .include('dialog')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', {name: 'Search documentation', exact: true})).toBeFocused();
});

test('search failures provide a usable fallback', async ({page}) => {
  await page.route('**/pagefind/**', (route) => route.abort());
  await page.goto('./');
  await page.getByRole('button', {name: 'Search documentation', exact: true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Search is unavailable');
  await expect(page.getByRole('dialog').getByRole('link', {name: 'Browse Learn'})).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`${colorScheme} theme: responsive layout and accessible surfaces`, async ({page}) => {
    test.setTimeout(90000);
    await page.emulateMedia({colorScheme, reducedMotion: 'reduce'});
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({width, height: 960});
      await page.goto('./');
      await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow, `Homepage overflow at ${width}px`).toBe(false);
      await expect(page.getByRole('link', {name: 'Get started', exact: true})).toBeVisible();
    }
    for (const route of [
      './',
      'learn',
      'docs/getting-started/install',
      'docs/ref/spec',
      'docs/ref/diagnostics',
      'docs/next/project/quality-dashboard',
      'trail',
      'docs/bridges/gsharp-for-kotlin-developers',
      'docs/bridges/gsharp-for-swift-developers',
      'concurrency',
    ]) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('data-has-hydrated', 'true');
      await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('body')).toHaveCSS(
        'color',
        colorScheme === 'dark' ? 'rgb(242, 237, 232)' : 'rgb(36, 33, 38)',
      );
      if (route === 'docs/ref/diagnostics') {
        const emphasizedCode = page.locator('article td > strong > code').filter({
          hasText: /^unsafe$/,
        });
        await expect(emphasizedCode).toHaveCount(1);
        await expect(emphasizedCode).toHaveCSS(
          'color',
          colorScheme === 'dark' ? 'rgb(242, 237, 232)' : 'rgb(36, 33, 38)',
        );
      }
      const results = await new AxeBuilder({page})
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map(({id, nodes}) => ({
          id,
          count: nodes.length,
          examples: nodes.slice(0, 5).map(({target, failureSummary, any, all, none}) => ({
            target,
            failureSummary,
            checks: [...any, ...all, ...none].map(({id, data}) => ({id, data})),
          })),
        })),
        `${colorScheme} theme: ${route}`,
      ).toEqual([]);
    }
  });
}

test('Kotlin bridge and downloadable Trail form a complete learning path', async ({
  page,
  request,
}) => {
  await page.goto('learn');
  await page.getByRole('link', {name: /For Kotlin developers/}).click();
  await expect(page).toHaveURL(/\/docs\/bridges\/gsharp-for-kotlin-developers/);
  await expect(page.getByRole('heading', {level: 1})).toHaveText('G# for Kotlin developers');
  await page.locator('article').getByRole('link', {name: 'Trail walkthrough', exact: true}).click();
  await expect(page).toHaveURL(/\/docs\/tutorials\/trail/);
  const download = page.locator('article a[href$=".zip"]');
  const response = await request.get((await download.getAttribute('href'))!);
  expect(response.status()).toBe(200);
  expect((await response.body()).subarray(0, 2).toString()).toBe('PK');
  await page.goto('trail');
  await page.getByText('Inspect the full JSON report', {exact: true}).click();
  await expect(page.locator('main')).toContainText('"failed": 0');
  await page.getByText('Read the complete Program.gs', {exact: true}).click();
  await expect(page.locator('main')).toContainText('func inspectAll');
});

test('zoom and touch-sized controls preserve navigation', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 960});
  await page.goto('docs/getting-started/install');
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  await expect(page.getByRole('heading', {level: 1})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('button', {name: 'Search documentation', exact: true}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox').fill('scope');
  await expect(dialog.locator('.gs-search-result')).not.toHaveCount(0);
  await dialog.locator('[class*="results_"]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByRole('button', {name: 'Close search'})).toBeInViewport();
  await expect(dialog.getByRole('searchbox')).toBeInViewport();
});
test('narrow navigation and command copying stay usable', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('./');
  await page.getByRole('button', {name: 'Toggle navigation bar'}).click();
  await expect(page.locator('.navbar-sidebar')).toBeVisible();
  await page.locator('.navbar-sidebar').getByRole('link', {name: 'Learn', exact: true}).click();
  await expect(page).toHaveURL(/\/learn$/);
  await page.goto('./');
  const commands = await page.getByLabel('Installation commands').innerText();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    }),
  );
  await page.getByRole('button', {name: 'Copy commands'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-copied', commands);
  await expect(page.getByRole('status')).toHaveText('Commands copied to clipboard.');
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {writeText: () => Promise.reject(new Error('Unavailable'))},
    }),
  );
  await page.getByRole('button', {name: 'Copied', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('Select and copy');
});

test('Swift and all ten pattern pairs are discoverable and runnable downloads', async ({
  page,
  request,
}) => {
  await page.goto('learn');
  await page.getByRole('link', {name: /For Swift developers/}).click();
  await expect(page.getByRole('heading', {level: 1})).toHaveText('G# for Swift developers');
  await page.locator('article').getByRole('link', {name: 'ten runnable Go/G# patterns'}).click();
  await expect(page).toHaveURL(/\/concurrency/);
  await expect(page.locator('section[aria-labelledby^="pattern-"]')).toHaveCount(10);
  await expect(page.locator('main')).toContainText('Whole-pattern performance: not measured.');
  const pool = page.locator('section[aria-labelledby="pattern-worker-pool"]');
  await pool.getByText('Compare the Go and G# implementations', {exact: true}).click();
  await expect(pool).toContainText('WaitGroup');
  await expect(pool).toContainText('scope');
  await expect(pool).toContainText('worker-pool count=40 sum=1560 empty=0');
  const link = page.getByRole('link', {name: 'Download all ten pairs'});
  const response = await request.get((await link.getAttribute('href'))!);
  expect(response.status()).toBe(200);
  expect((await response.body()).subarray(0, 2).toString()).toBe('PK');
  if (benchmark.status === 'available' && benchmark.measurement) {
    await expect(
      page.getByRole('heading', {name: 'What the workflow actually measured.'}),
    ).toBeVisible();
    await expect(page.locator('.gs-benchmark')).toContainText('not a 95% confidence interval');
    if (benchmark.scenarios.some((row) => row.goScenario === null)) {
      await expect(page.locator('.gs-benchmark')).toContainText('Not paired');
    }
    if (!benchmark.measurement.comparable) {
      await expect(page.locator('.gs-benchmark')).toContainText('Report-only aggregate');
    }
  } else {
    await expect(page.locator('.gs-benchmark')).toContainText('Measurements unavailable');
  }
});
