import { expect, test } from '@playwright/test';

// Requires running PostgreSQL, tool API, control plane, and console. There are no route mocks.
test('execute, inspect, export, replay, and compare real evaluation runs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Local services connected')).toBeVisible();
  await page.getByRole('button', { name: 'Scenario library' }).click();
  await expect(page.locator('.scenario-card')).toHaveCount(12);
  await page.screenshot({ path: 'test-results/scenario-library.png', fullPage: true });
  await page.locator('.scenario-card').first().getByRole('button', { name: 'Evaluate' }).click();
  await expect(page.getByRole('dialog', { name: 'New evaluation' })).toBeVisible();
  await page.getByLabel('Agent provider').selectOption('baseline');
  await page.getByRole('button', { name: 'Start evaluation' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('tab', { name: 'Tool trajectory' })).toBeVisible();
  await expect(page.locator('.score-ring strong')).toHaveText('100');
  await expect(page.locator('.trace-event')).not.toHaveCount(0);
  await expect(page.locator('.event-inspector')).toContainText('REQUEST ARGUMENTS');
  expect(
    await page
      .locator('.timeline')
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/evaluation-overview.png', fullPage: true });
  await page.getByRole('tab', { name: 'Rubric results' }).click();
  await expect(page.locator('.criterion')).toHaveCount(5);
  await expect(page.locator('.security-panel')).toContainText('No policy violations');
  const toolCriterion = page.locator('.criterion').filter({ hasText: 'Appropriate tool use' });
  await toolCriterion.locator('summary').click();
  await toolCriterion.locator('.criterion-evidence button').last().click();
  await expect(page.getByRole('tab', { name: 'Tool trajectory' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const linkedEvent = await page.locator('.trace-event.selected').boundingBox();
  const timeline = await page.locator('.timeline').boundingBox();
  expect(linkedEvent!.y).toBeGreaterThanOrEqual(timeline!.y - 1);
  expect(linkedEvent!.y + linkedEvent!.height).toBeLessThanOrEqual(
    timeline!.y + timeline!.height + 1,
  );
  await page.getByRole('tab', { name: 'State changes' }).click();
  await expect(page.locator('.diff-card')).not.toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^evaluation-.*\.json$/);
  await page.getByRole('button', { name: 'Replay scenario' }).click();
  await expect(page.getByRole('button', { name: 'Replay scenario' })).toBeEnabled({
    timeout: 90_000,
  });
  await page.getByRole('tab', { name: 'Compare runs' }).click();
  const comparisonOption = await page
    .locator('#comparison-run option')
    .nth(1)
    .getAttribute('value');
  expect(comparisonOption).toBeTruthy();
  await page.getByLabel('Comparison run').selectOption(comparisonOption!);
  await expect(page.locator('.comparison-result')).toBeVisible();
  await expect(page.locator('.comparison-result')).toContainText('SCORE DELTA');
});

test('flawed candidate exposes actionable rubric failures and works on narrow screens', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Local services connected')).toBeVisible();
  const newEvaluation = page.getByRole('button', { name: 'New evaluation', exact: true });
  await newEvaluation.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'New evaluation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(newEvaluation).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(newEvaluation).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByLabel('Agent provider').selectOption('careless');
  await page.getByRole('button', { name: 'Start evaluation' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 90_000 });
  await page.getByRole('tab', { name: 'Rubric results' }).click();
  await expect(page.locator('.criterion.failed')).not.toHaveCount(0);
  await page.screenshot({ path: 'test-results/failed-evaluation.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  for (const name of ['Overview', 'Scenario library', 'Run history', 'Methodology']) {
    await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(
    navigation.getByRole('button', { name: 'Overview', exact: true }).locator('span').first(),
  ).toBeHidden();
  await expect(page.getByRole('button', { name: 'Reviewer settings', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Tool trajectory' }).click();
  await expect(page.locator('.event-inspector')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/mobile-review.png', fullPage: true });
});
