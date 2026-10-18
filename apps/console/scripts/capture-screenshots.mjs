import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '../../..', 'docs/screenshots');
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const runs = await (await fetch(`${baseURL}/api/runs`)).json();
const baseline = runs.find(
  (run) =>
    run.scenario_id === 'lost-work-order-response' && run.provider === 'baseline' && run.passed,
);
const candidate = runs.find(
  (run) =>
    run.scenario_id === 'lost-work-order-response' &&
    run.provider === 'careless' &&
    !run.passed &&
    run.status !== 'running',
);
if (!baseline || !candidate)
  throw new Error('Record the demo or create baseline/careless lost-response runs first.');
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1536, height: 1100 },
  reducedMotion: 'reduce',
});
async function openRun(id) {
  await page.getByRole('button', { name: 'Run history' }).click();
  await page
    .locator('tr')
    .filter({ hasText: id.slice(0, 8) })
    .getByRole('button')
    .first()
    .click();
  await page.locator('.score-ring strong').waitFor();
  await page
    .locator('.summary-badges')
    .getByText(`RUN ${id.slice(0, 8)}`, { exact: true })
    .waitFor();
}
async function shot(name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, name), fullPage: true });
  console.log(`Captured ${name}`);
}
try {
  await page.goto(baseURL);
  await page.getByText('Local services connected').waitFor();
  await openRun(baseline.id);
  await shot('evaluation-overview.png');
  await page.locator('.trace-event').filter({ hasText: 'create_work_order' }).first().click();
  await shot('recovery-trace.png');
  await page.getByRole('tab', { name: 'Rubric results' }).click();
  await page.locator('.criterion').first().locator('summary').click();
  await shot('rubric-evidence.png');
  await page.getByRole('tab', { name: 'State changes' }).click();
  await shot('state-diff.png');
  await page.getByRole('tab', { name: 'Compare runs' }).click();
  await page.getByLabel('Comparison run').selectOption(candidate.id);
  await page.locator('.comparison-result').waitFor();
  await shot('comparison.png');
  await page.getByRole('button', { name: 'Scenario library' }).click();
  await shot('scenario-library.png');
  await openRun(candidate.id);
  await page.getByRole('tab', { name: 'Rubric results' }).click();
  await shot('failed-evaluation.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Tool trajectory' }).click();
  await shot('mobile-review.png');
} finally {
  await browser.close();
}
