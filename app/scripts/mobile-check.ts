#!/usr/bin/env bun
// Mobile viewport/touch checks. Orientation capability is simulated because
// desktop Chrome cannot rotate a physical phone; fullscreen itself remains real.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

declare global { interface Window { __pdoom: any } }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const capability of ['lock', 'lock-rejected', 'lock-pending', 'no-fullscreen'] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((capability) => {
      sessionStorage.setItem('pdoom-preview-v2', JSON.stringify({ hidden: true, blur: false, grain: false }));
      const calls = { lock: [] as string[], unlock: 0 };
      (window as any).__orientationTest = calls;
      Object.defineProperty(screen.orientation, 'lock', { configurable: true, value: async (mode: string) => {
        calls.lock.push(mode);
        if (capability === 'lock-rejected') throw new DOMException('Unsupported', 'NotSupportedError');
        if (capability === 'lock-pending') await new Promise<void>((resolve) => { (window as any).__finishLock = resolve; });
      } });
      Object.defineProperty(screen.orientation, 'unlock', { configurable: true, value: () => { calls.unlock++; } });
      if (capability === 'no-fullscreen') {
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: undefined });
        Object.defineProperty(HTMLElement.prototype, 'webkitRequestFullscreen', { configurable: true, value: undefined });
      }
    }, capability);
    await page.goto('http://127.0.0.1:5173/?warmup=0&only=loss&t=10.64');
    await page.waitForFunction(() => window.__pdoom?.ready, null, { timeout: 120000 });
    assert.equal(await page.locator('#ui').isVisible(), false);
    assert.equal(await page.locator('#show-ui').isVisible(), true, 'saved hidden UI must have a touch escape');
    await page.locator('#show-ui').tap();
    assert.equal(await page.locator('#ui').isVisible(), true);
    assert.equal(await page.evaluate(() => window.__pdoom.playing), false);

    await page.locator('#play').tap();
    await page.waitForFunction(() => window.__pdoom.playing);
    await page.locator('#hide-ui').tap();
    await page.locator('#c').tap();
    assert.equal(await page.locator('#ui').isVisible(), true);
    assert.equal(await page.evaluate(() => window.__pdoom.playing), true, 'revealing controls must not pause');
    await page.locator('#play').tap();

    await page.locator('#fullscreen').tap();
    await page.waitForFunction(() => !(document.querySelector('#fullscreen') as HTMLButtonElement).disabled);
    assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#player').evaluate((el) => el.classList.contains('landscape-layout')), true);
    assert.equal(await page.evaluate(() => !!document.fullscreenElement), capability !== 'no-fullscreen');
    assert.deepEqual(await page.evaluate(() => (window as any).__orientationTest.lock), capability === 'no-fullscreen' ? [] : ['landscape']);
    const layout = await page.locator('#player').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { width: el.clientWidth, height: el.clientHeight, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, vw: innerWidth, vh: innerHeight };
    });
    assert.ok(layout.width > layout.height, 'fallback must lay out a landscape player');
    assert.ok(Math.abs(layout.x) < 1 && Math.abs(layout.y) < 1 && Math.abs(layout.right - layout.vw) < 1 && Math.abs(layout.bottom - layout.vh) < 1, JSON.stringify(layout));

    // Hit testing must keep working even while the whole player is rotated.
    await page.locator('#hide-ui').tap();
    await page.locator('#show-ui').tap();
    assert.equal(await page.locator('#ui').isVisible(), true);
    await page.screenshot({ path: `../out/mobile-${capability}.png` });

    if (capability === 'lock') {
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => !document.querySelector('#player')!.classList.contains('landscape-layout'));
      assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'), 'true');
    }
    await page.locator('#fullscreen').tap();
    await page.waitForFunction(() => document.querySelector('#fullscreen')!.getAttribute('aria-pressed') === 'false');
    assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
    assert.equal(await page.locator('#player').evaluate((el) => el.classList.contains('landscape-layout')), false);
    if (capability !== 'no-fullscreen') assert.ok(await page.evaluate(() => (window as any).__orientationTest.unlock) > 0);
    if (capability === 'lock-pending') {
      await page.evaluate(() => (window as any).__finishLock());
      await page.waitForFunction(() => (window as any).__orientationTest.unlock >= 2);
      assert.equal(await page.locator('#player').evaluate((el) => el.classList.contains('landscape-layout')), false);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${capability}: remembered hidden controls, touch restore without pause, landscape layout, rotated hit testing, exit/unlock.`);
    await context.close();
  }
} finally { await browser.close(); }
