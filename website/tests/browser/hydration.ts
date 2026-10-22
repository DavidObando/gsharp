import {expect, type Page} from '@playwright/test';

export async function expectHydrated(page: Page): Promise<void> {
  // Pending locator assertions build an ARIA snapshot of the whole document.
  // On long reference pages, that work can delay Firefox hydration (Issue #4725).
  await expect
    .poll(
      () => page.evaluate(() => document.documentElement.getAttribute('data-has-hydrated')),
      {message: 'The document has hydrated'},
    )
    .toBe('true');
}
