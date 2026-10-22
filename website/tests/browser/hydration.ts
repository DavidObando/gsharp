import {expect, type Page} from '@playwright/test';

// Hydration cost scales with the size of the server-rendered DOM, and the
// browser's main thread is shared with the other workers' pages. The heaviest
// page (/concurrency, about 14,000 nodes) hydrates in roughly 3.5s in WebKit on
// an idle machine, and took 6s to 15s when the CPU was contended (Issue #5146).
// Playwright's default five-second expect budget therefore reports a slow
// runner as a hydration failure. This is a readiness wait, not a performance
// assertion: a page that never hydrates still fails, only after this longer
// ceiling. Do not shorten it to enforce a hydration speed; measure that
// separately.
const HYDRATION_TIMEOUT_MS = 45_000;

export async function expectHydrated(page: Page): Promise<void> {
  // Pending locator assertions build an ARIA snapshot of the whole document.
  // On long reference pages, that work can delay Firefox hydration (Issue #4725).
  await expect
    .poll(
      () => page.evaluate(() => document.documentElement.getAttribute('data-has-hydrated')),
      {message: 'The document has hydrated', timeout: HYDRATION_TIMEOUT_MS},
    )
    .toBe('true');
}
