import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const publicPricingPlans = [
  { id: 'access', name: 'Access', description: 'IPA Library and two new decrypts per day.', amount: 2.5, currency: 'EUR', api: false, priority: 0, dailyDecryptLimit: 2 },
  { id: 'standard', name: 'Standard', description: 'IPA Library and ten new decrypts per day.', amount: 5, currency: 'EUR', api: false, priority: 0, dailyDecryptLimit: 10 },
  { id: 'plus', name: 'Plus', description: 'IPA Library and 25 new decrypts per day.', amount: 10, currency: 'EUR', api: false, priority: 0, dailyDecryptLimit: 25 },
  { id: 'developer', name: 'Developer', description: 'IPA Library, 50 new decrypts per day, and API access.', amount: 15, currency: 'EUR', api: true, priority: 0, dailyDecryptLimit: 50, apiRatePerMinute: 30 },
  { id: 'unlimited', name: 'Unlimited', description: 'IPA Library, unlimited new decrypts, and API access.', amount: 20, currency: 'EUR', api: true, priority: 0, apiRatePerMinute: 60 },
  { id: 'unlimited_priority', name: 'Unlimited Priority', description: 'Unlimited new decrypts, API access, and higher queue priority.', amount: 30, currency: 'EUR', api: true, priority: 5, apiRatePerMinute: 120 },
];

async function mockPublicPricing(page: Page): Promise<void> {
  await page.route('**/pricing/catalog.json', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ plans: publicPricingPlans }) });
  });
}

async function expectAccessible(page: Page, scope?: string): Promise<void> {
  await page.locator('[data-sonner-toast]').evaluateAll(async (toasts) => {
    const animations = toasts.flatMap((toast) => toast.getAnimations({ subtree: true }))
      .filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  if (scope) builder.include(scope);
  const results = await builder.analyze();
  expect(results.violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    nodes: nodes.map(({ target, html, failureSummary }) => ({ target, html, failureSummary })),
  }))).toEqual([]);
}

async function expectVisualSnapshot(page: Page, target: Page | Locator, name: string, fullPage = false): Promise<void> {
  await page.addStyleTag({
    content: ':root, body { scrollbar-gutter: auto !important; scrollbar-width: none !important; } :root::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; } * { font-family: Arial, sans-serif !important; }',
  });
  await expect(target).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    fullPage,
    maxDiffPixelRatio: 0.08,
    scale: 'css',
  });
}

async function waitForBrowserFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function mockAuthenticatedSession(page: Page, permissions: string): Promise<void> {
  await page.unroute('**/v1/auth/session');
  await page.route('**/v1/auth/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        loggedIn: true,
        sub: 'member',
        displayName: 'Administrator',
        permissions,
        identities: [],
        linkedProviders: [],
        githubOauthEnabled: false,
        discordOauthEnabled: false,
        deployment: { ref: 'abcdef0123456789' },
        mfa: { enabled: false, recoveryCodesRemaining: 0, required: false },
      }),
    });
  });
  await page.route('**/v1/auth/passkeys', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ passkeys: [] }) });
  });
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ theme: 'dark', accent: 'violet', sound: true }) });
  });
}

async function mockAuthenticatedDashboard(page: Page, permissions: string): Promise<void> {
  await mockAuthenticatedSession(page, permissions);
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/events', async (route) => {
    await route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  });
  await page.route('**/v1/dashboard/jobs/volume*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ days: [] }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('onboardingTourSeen', 'true');
    localStorage.setItem('onboardingDismissed', 'true');
  });
}

async function mockVisualDashboardData(page: Page): Promise<void> {
  await page.route('**/v1/dashboard/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/dashboard/jobs/volume') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ days: [] }) });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        activeJobs: [],
        apps: [],
        auditLog: [],
        data: [],
        devices: [],
        entries: [],
        failurePatterns: [],
        jobs: [],
        keys: [],
        logs: [],
        members: [],
        notifications: [],
        patterns: [],
        projects: [],
        repos: [],
        roles: [],
        runs: [],
        settings: {},
        subscriptions: [],
        total: 0,
        users: [],
        watches: [],
        webhooks: [],
        workflows: [],
      }),
    });
  });
  await page.route('**/v1/billing*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/provider-status')
      ? { providers: [], enabled: false, ready: false }
      : path.endsWith('/subscriptions')
        ? { subscriptions: [], total: 0 }
        : { enabled: false, providers: {}, plans: [], entitlement: { planId: 'viewer', decrypt: true, api: false, priority: 0 } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('inactive billing waits for selection and stays mounted after first visit', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '2');
  let billingRequests = 0;
  await page.route('**/v1/billing', async (route) => {
    billingRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: false,
        provider: 'legacy',
        environment: 'live',
        managedPayments: false,
        missingConfiguration: [],
        plans: [],
        legacyBilling: false,
        entitlement: { planId: 'viewer', decrypt: true, api: false, priority: 0 },
        providers: {
          stripe: { enabled: false, ready: false, environment: 'live' },
          crypto: { enabled: false, ready: false, environment: 'live', provider: 'nowpayments', assets: [] },
        },
      }),
    });
  });

  const overviewLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/dashboard/overview');
  await page.goto('/?tab=home');
  await overviewLoaded;
  await waitForBrowserFrames(page);
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  expect(billingRequests).toBe(0);

  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  const billingHeading = page.locator('h2').filter({ hasText: 'Choose your dkrypt plan' });
  await expect(billingHeading).toBeVisible();
  await expect.poll(() => billingRequests).toBe(1);
  const billingRequestsAfterFirstVisit = billingRequests;

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(billingHeading).toBeAttached();
  await expect(billingHeading).toBeHidden();
  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  await expect(billingHeading).toBeVisible();
  await waitForBrowserFrames(page);
  expect(billingRequests).toBe(billingRequestsAfterFirstVisit);
});

test('billing revenue provider breakdown stays readable at wide and narrow desktop widths', async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 900 });
  await mockAuthenticatedDashboard(page, '137438953472');
  await page.route('**/v1/billing/revenue*', async (route) => {
    const total = { currency: 'EUR', gross: 25, refunded: 5, net: 20 };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        updatedAt: new Date().toISOString(),
        complete: true,
        totals: [total],
        retention: { activeAccounts: 1, paymentIssues: 0, cancellationsUpdatedLast30Days: 0, recentCancellationRatePercent: 0 },
        providers: {
          stripe: { state: 'ready', totals: [total], paymentCount: 2 },
          nowpayments: { state: 'ready', totals: [], paymentCount: 0 },
        },
        warnings: [],
      }),
    });
  });
  await page.route('**/v1/billing/provider-status*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        checkoutsPaused: false,
        stripe: { enabled: true, environment: 'live', missingConfiguration: [], webhook: { state: 'ready', endpointUrl: '', requiredEvents: [], missingEvents: [] } },
        crypto: { enabled: true, configured: true, ready: true, environment: 'live', settlementCurrency: 'EUR', supportedChains: ['Base'], supportedAssets: ['USDC'], missingConfiguration: [], issues: [] },
      }),
    });
  });
  await page.route('**/v1/billing/subscriptions*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ subscriptions: [], total: 0 }) });
  });
  await page.route('**/v1/billing/webhooks/inbox*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ inbox: [], total: 0 }) });
  });

  await page.goto('/?tab=settings&stab=billing');
  const breakdown = page.getByTestId('billing-revenue-provider-breakdown');
  await expect(breakdown).toBeVisible();
  for (const width of [840, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await breakdown.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      gridTemplateColumns: getComputedStyle(element).gridTemplateColumns,
      right: element.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
      children: Array.from(element.children).map((child) => ({ clientWidth: child.clientWidth, scrollWidth: child.scrollWidth, top: child.getBoundingClientRect().top })),
    }));
    expect(dimensions.viewportWidth).toBe(width);
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.gridTemplateColumns.trim().split(/\s+/)).toHaveLength(1);
    expect(dimensions.children.every((child) => child.scrollWidth <= child.clientWidth)).toBe(true);
    expect(dimensions.children[1]!.top).toBeGreaterThan(dimensions.children[0]!.top);
  }
});

test('command palette searches dkrypt data without triggering live App Store search', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  const quickSearchQueries: Array<{ q: string | null }> = [];
  let appStoreSearchRequests = 0;
  await page.route('**/v1/dashboard/quick-search*', async (route) => {
    const url = new URL(route.request().url());
    quickSearchQueries.push({ q: url.searchParams.get('q') });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ results: [{ kind: 'app', id: 'com.example.quick', title: 'Example App', subtitle: 'com.example.quick' }] }),
    });
  });
  await page.route('**/v1/dashboard/search*', async (route) => {
    appStoreSearchRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  });

  await page.goto('/?tab=home');
  await page.getByRole('button', { name: 'Open command menu' }).click();
  await page.getByPlaceholder('Search dkrypt…').fill('Example');
  await expect(page.getByRole('button', { name: /Example App App com\.example\./ })).toBeVisible();
  await expect.poll(() => quickSearchQueries.at(-1)).toEqual({ q: 'Example' });
  expect(appStoreSearchRequests).toBe(0);
  await page.getByRole('button', { name: /Example App App com\.example\./ }).click();
  await expect(page.getByPlaceholder('Search the App Store to decrypt… (press / to focus)')).toHaveValue('com.example.quick');
  await expect.poll(() => appStoreSearchRequests).toBe(1);
});

async function mockStableDashboardEvents(page: Page, failedConnections = 0, holdFirstReconnect = false): Promise<void> {
  await page.addInitScript(({ initialFailures, holdFirstReconnect: shouldHoldFirstReconnect }) => {
    let visibilityState: DocumentVisibilityState = 'visible';
    let failuresRemaining = initialFailures;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibilityState });
    const eventSources: Array<{ closeCount: number; source: EventTarget }> = [];
    class InstrumentedEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = InstrumentedEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private readonly record: { closeCount: number; source: EventTarget };

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        this.record = { closeCount: 0, source: this };
        eventSources.push(this.record);
        queueMicrotask(() => {
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            if (shouldHoldFirstReconnect) visibilityState = 'hidden';
            this.onerror?.(new Event('error'));
            return;
          }
          this.onopen?.(new Event('open'));
        });
      }

      close(): void {
        if (this.readyState === InstrumentedEventSource.CLOSED) return;
        this.readyState = InstrumentedEventSource.CLOSED;
        this.record.closeCount += 1;
      }
    }

    Object.defineProperty(window, 'EventSource', { configurable: true, value: InstrumentedEventSource });
    Object.assign(window, {
      __dkryptLiveTest: {
        eventSources,
        setVisibility(state: DocumentVisibilityState) {
          visibilityState = state;
          document.dispatchEvent(new Event('visibilitychange'));
        },
        emit(type: string, data: unknown) {
          const event = new MessageEvent(type, { data: JSON.stringify(data) });
          for (const source of eventSources) source.source.dispatchEvent(event);
        },
      },
    });
  }, { initialFailures: failedConnections, holdFirstReconnect });
}

async function mockBillingSubscriptions(page: Page, status: () => string): Promise<() => number> {
  let subscriptionRequests = 0;
  await page.route('**/v1/billing/subscriptions*', async (route) => {
    subscriptionRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        total: 1,
        subscriptions: [{
          user: { id: 'github:jayden', displayName: 'Jayden', email: 'jayden@example.test' },
          provider: 'stripe',
          subscriptionId: 'sub_live_billing',
          customerId: 'cus_live_billing',
          priceId: 'price_regular',
          productId: 'prod_regular',
          plan: { id: 'regular', name: 'Regular', amount: 5, currency: 'EUR' },
          status: status(),
          occurredAt: '2026-10-01T18:00:00.000Z',
          updatedAt: '2026-10-01T18:00:00.000Z',
          lastCharge: { attempts: [] },
        }],
      }),
    });
  });
  await page.route('**/v1/billing/provider-status*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        checkoutsPaused: false,
        stripe: { enabled: false, environment: 'test', missingConfiguration: [], webhook: { state: 'not_configured', endpointUrl: '', requiredEvents: [], missingEvents: [] } },
        crypto: { enabled: false, configured: false, ready: false, environment: 'test', settlementCurrency: 'EUR', supportedChains: [], supportedAssets: [], missingConfiguration: [], issues: [] },
      }),
    });
  });
  await page.route('**/v1/billing/webhooks/inbox*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ inbox: [], total: 0 }) });
  });
  return () => subscriptionRequests;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not mocked' }),
    });
  });
  await page.route('**/v1/auth/session', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unauthorized' }),
    });
  });
});

test('status page renders an operational service and remains keyboard accessible', async ({ page }) => {
  await page.route('**/v1/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'operational',
        checkedAt: '2026-09-24T20:00:00.000Z',
        deployment: { ref: 'abcdef0123456789' },
        components: {
          service: { state: 'operational' },
          automation: { state: 'operational' },
        },
      }),
    });
  });

  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'dkrypt status' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All systems operational' })).toBeVisible();
  await expect(page.getByText('Build abcdef0', { exact: true })).toBeVisible();
  await expect(page.getByText('Device automation', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scheduler' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Pricing' }).first()).toHaveAttribute('href', '/pricing');

  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();

  const unnamedControls = await page.locator('button').evaluateAll((buttons) => buttons.filter((button) => !button.getAttribute('aria-label') && !button.textContent?.trim()).length);
  expect(unnamedControls).toBe(0);
  await expectAccessible(page);
});

test('pricing page fits a phone viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockPublicPricing(page);
  await page.goto('/pricing');

  await expect(page.getByRole('heading', { name: 'Choose a dkrypt plan' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to subscribe' })).toHaveCount(6);

  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);

  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  await expectAccessible(page);
});

test('pricing page visual layout stays consistent on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockPublicPricing(page);
  await page.goto('/pricing');
  await expect(page.getByRole('heading', { name: 'Choose a dkrypt plan' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to subscribe' })).toHaveCount(6);
  await expectVisualSnapshot(page, page, 'pricing-desktop.png', true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectVisualSnapshot(page, page, 'pricing-mobile.png', true);
});

test('device overview visual layout stays consistent on desktop and mobile', async ({ page }) => {
  const device = {
    id: 'visual-device',
    name: 'Lab iPad',
    transport: 'usb',
    port: 22,
    user: 'mobile',
    udid: '00008110-001234567890001E',
    productType: 'iPad14,1',
    iosVersion: '18.0',
    enabled: true,
    isPrimary: true,
    createdAt: 1,
    updatedAt: 1,
  };

  await mockVisualDashboardData(page);
  await mockAuthenticatedSession(page, '2097152');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [device],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/events', async (route) => {
    await route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  });
  await page.route('**/v1/dashboard/devices/visual-device/health*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        reachable: true,
        screenIsOn: false,
        batteryPercent: 82,
        checkedAt: 1790604000000,
        bridgeHeartbeats: { springboard: { bridgeVersion: '1.2.0' } },
        readiness: { score: 100, state: 'ready', reasons: [] },
        subsystems: { usb: 'ready', mux: 'ready', agent: 'ready', appStore: 'ready', testFlight: 'ready', sshTunnel: 'ready' },
      }),
    });
  });
  await page.route('**/v1/dashboard/devices/visual-device/activity*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ activity: [], total: 0 }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('onboardingTourSeen', 'true');
    localStorage.setItem('onboardingDismissed', 'true');
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?tab=settings&stab=devices');
  const deviceCard = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Devices', exact: true }) });
  await expect(page.getByText('Lab iPad', { exact: true })).toBeVisible();
  await expectVisualSnapshot(page, deviceCard, 'devices-desktop.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectVisualSnapshot(page, deviceCard, 'devices-mobile.png');
});

test('IPA Library visual layout stays consistent on desktop and mobile', async ({ page }) => {
  await mockVisualDashboardData(page);
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ entries: [{ bundleId: 'com.example.visual', displayName: 'Visual App', displayNameLanguage: 'en', updatedAt: 1790604000000 }] }),
    });
  });
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifacts: [{
          id: 'visual-artifact',
          key: 'com.example.visual:appstore:123',
          projectIds: ['default'],
          bundleId: 'com.example.visual',
          channel: 'appstore',
          versionLabel: '348.0',
          buildNumber: '113691',
          fileSizeBytes: 104857600,
          sha256: 'a'.repeat(64),
          createdAt: '2026-09-25T12:00:00.000Z',
          lastAccessedAt: '2026-09-25T13:00:00.000Z',
          accessCount: 3,
          sourceJobId: 'job-visual',
          warnings: [],
          fileUrl: '/v1/dashboard/artifacts/visual-artifact/file',
        }],
        total: 1,
        totalBytes: 104857600,
        maxBytes: 1048576000,
      }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  const artifactResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/artifacts?') && response.ok());
  await page.goto('/?tab=home');
  await artifactResponse;
  const libraryCard = page.locator('[data-slot="card"]').filter({ hasText: 'IPA Library' });
  await expect(page.getByText('Visual App', { exact: true })).toBeVisible();
  const artifactRow = libraryCard.locator('[data-artifact-id="visual-artifact"]');
  await expect(artifactRow.locator('dd > span.break-words.font-semibold')).toHaveText('348.0 (113691)');
  const metadataRows = await artifactRow.locator('dt').evaluateAll((headings) => Object.fromEntries(headings.map((heading) => [heading.textContent?.trim(), heading.getBoundingClientRect().top])));
  expect(metadataRows.Size).toBeGreaterThan(metadataRows.App);
  const actionsTop = await artifactRow.locator('.artifact-library-row-actions').evaluate((element) => element.getBoundingClientRect().top);
  expect(actionsTop).toBeGreaterThan(metadataRows.App + 35);
  await expectVisualSnapshot(page, libraryCard, 'ipa-library-desktop.png');

  const boundaryStyle = await page.addStyleTag({ content: '[data-artifact-id="visual-artifact"] { width: calc(100% - 2px); }' });
  const boundaryActionsTop = await artifactRow.locator('.artifact-library-row-actions').evaluate((element) => element.getBoundingClientRect().top);
  expect(boundaryActionsTop).toBeGreaterThan(metadataRows.App + 35);
  await boundaryStyle.evaluate((element) => element.remove());

  for (const width of [1200, 1652]) {
    await page.setViewportSize({ width, height: 1000 });
    const rows = await artifactRow.locator('dt').evaluateAll((headings) => Object.fromEntries(headings.map((heading) => [heading.textContent?.trim(), heading.getBoundingClientRect().top])));
    if (width === 1200) expect(rows.Size, `viewport ${width}`).toBeGreaterThan(rows.App);
    const rowActionsTop = await artifactRow.locator('.artifact-library-row-actions').evaluate((element) => element.getBoundingClientRect().top);
    expect(rowActionsTop, `viewport ${width}`).toBeGreaterThanOrEqual(rows.App);
    const versionIsVisible = await artifactRow.locator('dd > span.break-words.font-semibold').evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(versionIsVisible, `viewport ${width}`).toBe(true);
    if (width === 1200) await expectVisualSnapshot(page, libraryCard, 'ipa-library-narrow-desktop.png');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileRows = await artifactRow.locator('dt').evaluateAll((headings) => Object.fromEntries(headings.map((heading) => [heading.textContent?.trim(), heading.getBoundingClientRect().top])));
  expect(mobileRows.Size).toBeGreaterThan(mobileRows.Version);
  const mobileVersionIsVisible = await artifactRow.locator('dd > span.break-words.font-semibold').evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(mobileVersionIsVisible).toBe(true);
  await expectVisualSnapshot(page, libraryCard, 'ipa-library-mobile.png');
});

test('IPA Library keeps app and bundle names readable with browser and dashboard sidebars open', async ({ page }) => {
  await mockVisualDashboardData(page);
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [{ bundleId: 'com.hammerandchisel.discord', displayName: 'Discord - Talk, Play, Hang Out', displayNameLanguage: 'en', updatedAt: Date.now() }] }) });
  });
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ artifacts: [{ id: 'sidebar-artifact', bundleId: 'com.hammerandchisel.discord', channel: 'testflight', versionLabel: '351.0', buildNumber: '116422', fileSizeBytes: 110900000, createdAt: new Date().toISOString(), pinnedAt: Date.now(), fileUrl: '/download/sidebar-artifact' }], total: 1, totalBytes: 110900000, maxBytes: 1_000_000_000 }) });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?tab=home');
  const row = page.locator('[data-artifact-id="sidebar-artifact"]');
  const appName = row.getByRole('button', { name: 'Show full value: Discord - Talk, Play, Hang Out' });
  const bundleId = row.getByRole('button', { name: 'Show full value: com.hammerandchisel.discord' });
  await expect(appName).toBeVisible({ timeout: 15_000 });
  for (const width of [1440, 1180, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const field of [appName, bundleId]) {
      const clipped = await field.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
      expect(clipped, `${width}px ${await field.getAttribute('aria-label')}`).toBe(false);
    }
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), `${width}px artifact row overflow`).toBe(true);
  }
});

test('collapsed sidebar gives library and history content the released space', async ({ page }) => {
  await mockVisualDashboardData(page);
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifacts: [
          { id: 'layout-artifact', bundleId: 'com.example.layout', channel: 'appstore', versionLabel: '348.0', buildNumber: '113691', fileSizeBytes: 104857600, createdAt: '2026-09-25T12:00:00.000Z', fileUrl: '/v1/dashboard/artifacts/layout-artifact/file' },
          { id: 'layout-artifact-long', bundleId: 'com.example.a.much.longer.bundle.identifier', channel: 'testflight', versionLabel: '1.2.3', buildNumber: '9', fileSizeBytes: 1234567, createdAt: '2026-09-24T12:00:00.000Z', fileUrl: '/v1/dashboard/artifacts/layout-artifact-long/file' },
        ],
        total: 2,
        totalBytes: 104857600,
        maxBytes: 1048576000,
      }),
    });
  });
  await page.route('**/v1/dashboard/jobs?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ history: [{ id: 'layout-job', bundleId: 'com.example.layout', status: 'done', source: 'manual', createdAt: Date.now() - 60_000, finishedAt: Date.now() - 30_000, fileAvailable: true, downloadUrl: '/download/layout-job' }], total: 1 }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?tab=home');
  const artifactRow = page.locator('[data-artifact-id="layout-artifact"]');
  const historyRow = page.locator('.history-feed-row').first();
  await expect(artifactRow).toBeVisible();
  await expect(historyRow).toBeVisible();
  await expect(artifactRow.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Bulk artifact actions' })).toHaveCount(0);
  const detailsButton = artifactRow.getByRole('button', { name: 'Artifact details' });
  const downloadButton = artifactRow.getByRole('link', { name: /Download/ });
  const detailsBox = await detailsButton.boundingBox();
  const downloadBox = await downloadButton.boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(downloadBox).not.toBeNull();
  expect(downloadBox?.width).toBe(detailsBox?.width);
  expect(downloadBox?.height).toBe(detailsBox?.height);

  const otherArtifactRow = page.locator('[data-artifact-id="layout-artifact-long"]');
  await expect(otherArtifactRow).toBeVisible();
  const columnStarts = async (row: typeof artifactRow) => row.locator('dt').evaluateAll((headings) => Object.fromEntries(headings.map((heading) => [heading.textContent?.trim(), Math.round(heading.getBoundingClientRect().left)])));
  expect(await columnStarts(otherArtifactRow)).toEqual(await columnStarts(artifactRow));

  const before = await historyRow.locator('.history-feed-summary').evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  const after = await historyRow.locator('.history-feed-summary').evaluate((element) => element.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before + 100);
  expect(await columnStarts(otherArtifactRow)).toEqual(await columnStarts(artifactRow));
  const versionWidth = await artifactRow.locator('dt', { hasText: 'Version' }).locator('..').evaluate((element) => element.getBoundingClientRect().width);
  expect(versionWidth).toBeLessThan(175);
  const versionIsVisible = await artifactRow.locator('dt', { hasText: 'Version' }).locator('..').locator('dd > span').evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(versionIsVisible).toBe(true);
  const appWidth = await artifactRow.locator('dt', { hasText: 'App' }).locator('..').evaluate((element) => element.getBoundingClientRect().width);
  expect(appWidth).toBeGreaterThan(versionWidth);

  await page.getByRole('button', { name: 'Select items' }).click();
  await expect(artifactRow.getByRole('checkbox')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Bulk artifact actions' })).toBeVisible();

  await page.setViewportSize({ width: 2048, height: 1000 });
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  const wideBefore = await artifactRow.evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  const wideAfter = await artifactRow.evaluate((element) => element.getBoundingClientRect().width);
  expect(wideAfter).toBeGreaterThan(wideBefore + 100);
});

test('job history cards keep names and actions readable from desktop to phone widths', async ({ page }) => {
  await mockVisualDashboardData(page);
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/jobs?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ history: [{ id: 'job-card-layout', bundleId: 'com.example.a.long.bundle.identifier', status: 'done', source: 'scheduler', versionLabel: '348.0 (113691)', createdAt: Date.now() - 60_000, finishedAt: Date.now() - 30_000, fileAvailable: true, artifactId: 'job-card-artifact', downloadUrl: '/download/job-card-artifact' }], total: 1 }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?tab=home');
  await expect(page.getByRole('button', { name: 'Any source' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manual', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'System', exact: true })).toHaveCount(0);
  const row = page.locator('.history-feed-row').first();
  await expect(row).toBeVisible();
  const rowWidth = await row.evaluate((element) => element.getBoundingClientRect().width);
  const summaryWidth = await row.locator('.history-feed-summary').evaluate((element) => element.getBoundingClientRect().width);
  expect(summaryWidth).toBeGreaterThan(rowWidth * 0.55);

  await page.setViewportSize({ width: 320, height: 568 });
  const actions = row.locator('.history-feed-actions');
  await expect(actions).toBeVisible();
  const actionBounds = await actions.boundingBox();
  const mobileRowBounds = await row.boundingBox();
  const lastActionBounds = await actions.locator('button, a').last().boundingBox();
  expect(actionBounds).not.toBeNull();
  expect(mobileRowBounds).not.toBeNull();
  expect(lastActionBounds).not.toBeNull();
  expect(actionBounds!.height).toBeLessThanOrEqual(36);
  expect(actionBounds!.x).toBeGreaterThanOrEqual(0);
  expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(320);
  expect(lastActionBounds!.x + lastActionBounds!.width).toBeGreaterThan(mobileRowBounds!.x + mobileRowBounds!.width - 20);
  const iconBounds = await row.locator('.history-feed-summary span[aria-label]').first().boundingBox();
  const nameBounds = await row.getByRole('button', { name: 'com.example.a.long.bundle.identifier' }).boundingBox();
  expect(iconBounds).not.toBeNull();
  expect(nameBounds).not.toBeNull();
  expect(Math.abs(iconBounds!.y - nameBounds!.y)).toBeLessThanOrEqual(4);

  await page.goto('/?tab=home&hsource=scheduler');
  await expect(page.locator('.history-feed-row')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('hsource')).toBeNull();
});

test('job history groups version and status while keeping actions beside the app at constrained desktop widths', async ({ page }) => {
  await mockVisualDashboardData(page);
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [{ bundleId: 'com.hammerandchisel.discord', displayName: 'Discord - Talk, Play, Hang Out', displayNameLanguage: 'en', updatedAt: Date.now() }] }) });
  });
  await page.route('**/v1/dashboard/jobs?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ history: [{ id: 'job-sidebar-layout', bundleId: 'com.hammerandchisel.discord', status: 'done', source: 'scheduler', testflight: true, versionLabel: '351.0_116422', sizeBytes: 110900000, createdAt: Date.now() - 60_000, finishedAt: Date.now() - 30_000, fileAvailable: true, artifactId: 'sidebar-artifact', downloadUrl: '/download/sidebar-artifact' }], total: 1 }) });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?tab=home');
  const row = page.locator('.history-feed-row').first();
  await expect(row).toBeVisible();
  const appName = row.getByRole('button', { name: 'Discord - Talk, Play, Hang Out' });
  const version = row.getByText('351.0_116422', { exact: true });
  const status = row.getByText('done', { exact: true });
  const actions = row.locator('.history-feed-actions');
  const [appBox, versionBox, statusBox, actionBox] = await Promise.all([appName.boundingBox(), version.boundingBox(), status.boundingBox(), actions.boundingBox()]);
  expect(appBox).not.toBeNull();
  expect(versionBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(Math.abs(versionBox!.y - statusBox!.y)).toBeLessThanOrEqual(8);
  expect(Math.abs(appBox!.y - actionBox!.y)).toBeLessThanOrEqual(8);
  const sourceBox = await row.getByText('TestFlight', { exact: true }).boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(Math.abs(versionBox!.y - sourceBox!.y)).toBeLessThanOrEqual(8);
  await expectVisualSnapshot(page, row, 'job-history-narrow-desktop.png');

  await page.setViewportSize({ width: 320, height: 900 });
  expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(row.getByRole('button', { name: 'Inspect job' })).toBeVisible();
  await expect(row.getByRole('link', { name: 'Download IPA' })).toBeVisible();
  await row.getByRole('button', { name: 'Inspect job' }).click();
  await expect(page.getByRole('dialog', { name: 'Discord - Talk, Play, Hang Out (351.0_116422)' })).toBeVisible();
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.addStyleTag({ content: '.mobile-primary-nav { display: none !important; }' });
  await expectVisualSnapshot(page, row, 'job-history-mobile.png');
});

test('regular members see operational Status details without device controls', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '0');
  await mockStableDashboardEvents(page);
  await page.unroute('**/v1/dashboard/overview*');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      settings: {},
      devices: [],
      statusDevices: [{ id: 'device-1', name: 'Lab iPad', enabled: true, isPrimary: true, reachable: true }],
      deviceStatus: { configured: 1, enabled: 1, online: 1, ready: 1, attention: 0, checking: 0, unavailable: 0 },
      disk: { totalBytes: 1000, freeBytes: 800, usedBytes: 200, usedPercent: 0.2 },
      maintenance: { active: false, manual: false, auto: false },
      activeJobs: [],
    }) });
  });
  await page.route('**/v1/dashboard/devices/primary/health', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reachable: true, checkedAt: Date.now(), testFlightBridgeReachable: true, testFlightRunning: true, batteryPercent: 83, batteryCharging: true, batteryTemperatureC: 31, networkConnected: true, internetAccess: true, networkInterface: 'en0', networkIpAddress: '192.0.2.44', storageUsedPercent: 0.2 }) });
  });
  await page.route('**/v1/dashboard/devices/primary/health-history?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ buckets: [{ hourStart: Date.now() - 3600_000, reachablePercent: 1, transitions: 0 }], uptimePercent: 1 }) });
  });
  await page.route('**/v1/dashboard/devices/primary/battery-history?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ buckets: [{ hourStart: Date.now() - 3600_000, batteryPercent: 83 }] }) });
  });
  await page.route('**/v1/dashboard/devices/primary/temperature-history?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ buckets: [{ hourStart: Date.now() - 3600_000, batteryTemperatureC: 31 }] }) });
  });

  await page.goto('/?tab=home');
  await page.getByRole('button', { name: 'Open status drawer' }).click();
  const status = page.locator('.status-surface:visible').first();
  await expect(status.getByText('Scheduler on')).toHaveCount(0);
  await expect(status.getByText('Device online')).toBeVisible();
  await expect(status.getByText('83%')).toBeVisible();
  await expect(status.getByText('Device reachability · last 24h')).toBeVisible();
  await expect(status.getByText('Recent scheduler checks')).toHaveCount(0);
  await expect(status.getByText('Staging disk')).toBeVisible();
  await expect(status.getByRole('button', { name: 'Refresh device status' })).toHaveCount(0);
  await expect(status.getByRole('button', { name: /Copy debug info/ })).toHaveCount(0);
  await status.getByRole('button', { name: 'Internet' }).click();
  await expect(page.getByText('192.0.2.44')).toBeVisible();
});

test('device ready status expires when its health sample becomes stale', async ({ page }) => {
  const statusNow = Date.now();
  await page.clock.install({ time: statusNow });
  await mockAuthenticatedDashboard(page, '0');
  await mockStableDashboardEvents(page);
  await page.unroute('**/v1/dashboard/overview*');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      settings: {},
      devices: [],
      statusDevices: [{ id: 'device-1', name: 'Lab iPad', enabled: true, isPrimary: true, reachable: true }],
      deviceStatus: { configured: 1, enabled: 1, online: 1, ready: 1, attention: 0, checking: 0, unavailable: 0, freshUntil: statusNow + 10_000 },
      disk: { totalBytes: 1000, freeBytes: 800, usedBytes: 200, usedPercent: 0.2 },
      maintenance: { active: false, manual: false, auto: false },
      activeJobs: [],
    }) });
  });
  await page.route('**/v1/dashboard/devices/primary/health', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'health unavailable' }) });
  });

  await page.goto('/?tab=home');
  await page.getByRole('button', { name: 'Open status drawer' }).click();
  const status = page.locator('.status-surface:visible').first();
  await expect(status.getByText('1 device ready')).toBeVisible();
  await page.clock.fastForward(15_000);
  await expect(status.getByText('Device status outdated')).toBeVisible();
});

test('live updates suspend while hidden and refresh immediately when visible again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.goto('/?tab=home');

  const eventSourceCount = () => page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { eventSources: Array<{ closeCount: number }> };
  }).__dkryptLiveTest.eventSources.length);
  const eventSourceCloseCount = () => page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { eventSources: Array<{ closeCount: number }> };
  }).__dkryptLiveTest.eventSources.reduce((count, source) => count + source.closeCount, 0));

  await expect.poll(eventSourceCount).toBe(1);
  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('hidden'));
  await expect.poll(eventSourceCloseCount, { timeout: 1_000 }).toBe(1);
  await expect.poll(eventSourceCount).toBe(1);

  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('visible'));
  await expect.poll(eventSourceCount).toBe(2);

  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('hidden'));
  await expect.poll(eventSourceCloseCount).toBe(2);
  let loggedIn = true;
  await page.unroute('**/v1/auth/session');
  await page.route('**/v1/auth/session', async (route) => {
    await route.fulfill(loggedIn
      ? { contentType: 'application/json', body: JSON.stringify({ loggedIn: true, sub: 'member', displayName: 'Administrator', permissions: '1', identities: [], linkedProviders: [], githubOauthEnabled: false, discordOauthEnabled: false, deployment: { ref: 'abcdef0123456789' }, mfa: { enabled: false, recoveryCodesRemaining: 0, required: false } }) }
      : { contentType: 'application/json', body: JSON.stringify({ loggedIn: false }) });
  });
  await page.route('**/v1/auth/logout', async (route) => {
    loggedIn = false;
    await route.fulfill({ status: 204, body: '' });
  });
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('visible'));
  await expect.poll(eventSourceCount).toBe(2);
});

test('billing subscriptions refresh when a subscription change arrives over dashboard events', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let status = 'active';
  const subscriptionRequests = await mockBillingSubscriptions(page, () => status);

  await page.goto('/?tab=settings&stab=billing');
  const subscriptionRow = page.getByRole('row').filter({ hasText: 'sub_live_billing' });
  await expect(subscriptionRow).toContainText('active');
  const initialRequestCount = subscriptionRequests();

  status = 'revoked';
  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { emit(type: string, data: unknown): void };
  }).__dkryptLiveTest.emit('billing', { sequence: 1 }));

  await expect.poll(subscriptionRequests).toBeGreaterThan(initialRequestCount);
  await expect(subscriptionRow).toContainText('revoked');
});

test('billing refreshes when the first successful dashboard connection recovers from an outage', async ({ page }) => {
  await mockStableDashboardEvents(page, 1, true);
  await mockAuthenticatedDashboard(page, '1');
  let status = 'active';
  const subscriptionRequests = await mockBillingSubscriptions(page, () => status);

  await page.goto('/?tab=settings&stab=billing');
  const subscriptionRow = page.getByRole('row').filter({ hasText: 'sub_live_billing' });
  await expect(subscriptionRow).toContainText('active');
  const initialRequestCount = subscriptionRequests();
  status = 'revoked';

  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('visible'));

  const eventSourceCount = () => page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { eventSources: Array<{ closeCount: number }> };
  }).__dkryptLiveTest.eventSources.length);
  await expect.poll(eventSourceCount).toBe(2);
  await expect.poll(subscriptionRequests).toBeGreaterThan(initialRequestCount);
  await expect(subscriptionRow).toContainText('revoked');
});

test('billing refreshes when an SSE sequence gap may have hidden a subscription update', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let status = 'active';
  const subscriptionRequests = await mockBillingSubscriptions(page, () => status);

  await page.goto('/?tab=settings&stab=billing');
  const subscriptionRow = page.getByRole('row').filter({ hasText: 'sub_live_billing' });
  await expect(subscriptionRow).toContainText('active');
  const initialRequestCount = subscriptionRequests();
  status = 'revoked';

  await page.evaluate(() => {
    const liveTest = (window as typeof window & {
      __dkryptLiveTest: { emit(type: string, data: unknown): void };
    }).__dkryptLiveTest;
    liveTest.emit('presence', { sequence: 1, data: [] });
    liveTest.emit('presence', { sequence: 3, data: [] });
  });

  await expect.poll(subscriptionRequests).toBeGreaterThan(initialRequestCount);
  await expect(subscriptionRow).toContainText('revoked');
});

test('live updates keep stale data visible until a reconnect refresh succeeds', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let overviewRequests = 0;
  let releaseFailedRefresh!: () => void;
  let markFailedRefreshStarted!: () => void;
  const failedRefreshStarted = new Promise<void>((resolve) => {
    markFailedRefreshStarted = resolve;
  });
  const awaitFailedRefreshGate = new Promise<void>((resolve) => {
    releaseFailedRefresh = resolve;
  });
  const overviewPayload = {
    schedulerEnabled: false,
    settings: {},
    watches: [],
    devices: [],
    schedulerRunHistory: [],
    disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
    isPaidPlan: false,
    maintenance: { active: false, manual: false, auto: false },
    activeJobs: [],
  };
  await page.route('**/v1/dashboard/overview*', async (route) => {
    overviewRequests += 1;
    if (overviewRequests === 2) {
      markFailedRefreshStarted();
      await awaitFailedRefreshGate;
      await route.fulfill({ status: 503, body: '' });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overviewPayload) });
  });
  await page.goto('/?tab=home');
  await expect.poll(() => overviewRequests).toBe(1);

  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('hidden'));
  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('visible'));
  await failedRefreshStarted;
  await expect(page.getByText('Reconnected - refreshing data…')).toBeVisible();

  const failedRefreshResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/dashboard/overview' && response.status() === 503);
  releaseFailedRefresh();
  await failedRefreshResponse;
  await expect(page.getByText('Dashboard data refresh failed. Try again.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry refresh' }).click();
  await expect.poll(() => overviewRequests).toBe(3);
  await expect(page.getByText('Reconnected - refreshing data…')).toBeHidden();
});

test('live reconnect ignores overview refreshes started before suspension', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let overviewRequests = 0;
  let releaseInitialOverview!: () => void;
  let releaseReconnectedOverview!: () => void;
  let markInitialOverviewStarted!: () => void;
  let markInitialOverviewFinished!: () => void;
  let markReconnectedOverviewStarted!: () => void;
  let markReconnectedOverviewFinished!: () => void;
  const initialOverviewGate = new Promise<void>((resolve) => {
    releaseInitialOverview = resolve;
  });
  const reconnectedOverviewGate = new Promise<void>((resolve) => {
    releaseReconnectedOverview = resolve;
  });
  const initialOverviewStarted = new Promise<void>((resolve) => {
    markInitialOverviewStarted = resolve;
  });
  const initialOverviewFinished = new Promise<void>((resolve) => {
    markInitialOverviewFinished = resolve;
  });
  const reconnectedOverviewStarted = new Promise<void>((resolve) => {
    markReconnectedOverviewStarted = resolve;
  });
  const reconnectedOverviewFinished = new Promise<void>((resolve) => {
    markReconnectedOverviewFinished = resolve;
  });
  const overviewPayload = {
    schedulerEnabled: false,
    settings: {},
    watches: [],
    devices: [],
    schedulerRunHistory: [],
    disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
    isPaidPlan: false,
    maintenance: { active: false, manual: false, auto: false },
    activeJobs: [],
  };
  await page.route('**/v1/dashboard/overview*', async (route) => {
    overviewRequests += 1;
    if (overviewRequests === 1) {
      markInitialOverviewStarted();
      await initialOverviewGate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overviewPayload) });
      markInitialOverviewFinished();
      return;
    }
    if (overviewRequests === 2) {
      markReconnectedOverviewStarted();
      await reconnectedOverviewGate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overviewPayload) });
      markReconnectedOverviewFinished();
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overviewPayload) });
  });
  await page.goto('/?tab=home');
  await initialOverviewStarted;

  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('hidden'));
  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('visible'));
  await expect.poll(() => overviewRequests, { timeout: 1_500 }).toBe(2);
  await reconnectedOverviewStarted;
  await expect(page.getByText('Reconnected - refreshing data…')).toBeVisible();

  releaseInitialOverview();
  await initialOverviewFinished;
  await expect(page.getByText('Reconnected - refreshing data…')).toBeVisible();
  releaseReconnectedOverview();
  await reconnectedOverviewFinished;
  await expect(page.getByText('Reconnected - refreshing data…')).toBeHidden();
});

test('IPA Library filters can be saved and reapplied across reloads', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  const requestedFilters: Array<{ channel: string; query: string; archived: boolean }> = [];
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    const requestUrl = new URL(route.request().url());
    requestedFilters.push({
      channel: requestUrl.searchParams.get('channel') ?? 'all',
      query: requestUrl.searchParams.get('q') ?? '',
      archived: requestUrl.searchParams.get('archived') === 'true',
    });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts: [], total: 0, totalBytes: 0, maxBytes: 1024 }),
    });
  });

  await page.goto('/?tab=home');
  const search = page.getByRole('textbox', { name: 'Search apps or versions…' });
  await search.fill('com.example.saved');
  await search.press('Enter');
  await expect.poll(() => requestedFilters.at(-1)?.query).toBe('com.example.saved');
  await page.getByRole('combobox', { name: 'All sources' }).click();
  await page.getByRole('option', { name: 'TestFlight', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'testflight', query: 'com.example.saved', archived: false });

  await page.getByRole('combobox', { name: /Active/ }).click();
  await page.getByRole('option', { name: 'Archived', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'testflight', query: 'com.example.saved', archived: true });

  await page.getByRole('textbox', { name: 'Saved filter name' }).fill('Archived TestFlight');
  await page.getByRole('button', { name: 'Save filter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Archived TestFlight', exact: true })).toBeVisible();

  await page.getByRole('combobox', { name: 'TestFlight', exact: true }).click();
  await page.getByRole('option', { name: 'App Store', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'appstore', query: 'com.example.saved', archived: true });
  await page.getByRole('combobox', { name: /Archived/ }).click();
  await page.getByRole('option', { name: 'Active', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'appstore', query: 'com.example.saved', archived: false });
  await page.getByRole('button', { name: 'Archived TestFlight', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'testflight', query: 'com.example.saved', archived: true });

  await page.reload();
  await expect(page.getByRole('button', { name: 'Archived TestFlight', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Archived TestFlight', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'testflight', query: 'com.example.saved', archived: true });
  await expect(search).toHaveValue('com.example.saved');
  await expectAccessible(page);
});

test('IPA Library archive and restore keep archive state separate from eviction protection', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '8589934594');
  const artifact = {
    id: 'archive-artifact',
    key: 'com.example.archive:appstore:123',
    projectIds: ['default'],
    bundleId: 'com.example.archive',
    channel: 'appstore',
    versionLabel: '2.4.0',
    buildNumber: '240',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    fileUrl: '/v1/dashboard/artifacts/archive-artifact/file',
  };
  let artifactArchivedAt: string | undefined;
  let artifactPinnedAt: string | undefined;
  let artifactArchivedRevision = 0;
  let artifactPinnedRevision = 0;
  let artifactListRequestCount = 0;
  const bulkArchiveRequests: Array<{ ids: string[]; archived: boolean }> = [];
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'PUT' && url.pathname.endsWith('/archive')) {
      const payload = route.request().postDataJSON() as { archived: boolean };
      const previousArchivedAt = artifactArchivedAt === undefined ? undefined : Date.parse(artifactArchivedAt);
      artifactArchivedAt = payload.archived ? '2026-09-26T13:00:00.000Z' : undefined;
      artifactArchivedRevision += 1;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, changed: true, artifactId: artifact.id, archived: payload.archived, archivedAt: artifactArchivedAt, archivedStateChangedAt: artifactArchivedRevision, previousArchivedAt }) });
      return;
    }
    if (route.request().method() === 'PUT' && url.pathname.endsWith('/pin')) {
      const payload = route.request().postDataJSON() as { pinned: boolean };
      const previousPinnedAt = artifactPinnedAt === undefined ? undefined : Date.parse(artifactPinnedAt);
      artifactPinnedAt = payload.pinned ? '2026-09-26T14:00:00.000Z' : undefined;
      artifactPinnedRevision += 1;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, changed: true, artifactId: artifact.id, pinned: payload.pinned, pinnedAt: artifactPinnedAt, pinnedStateChangedAt: artifactPinnedRevision, previousPinnedAt }) });
      return;
    }
    if (route.request().method() === 'POST') {
      if (url.pathname.endsWith('/undo')) {
        const payload = route.request().postDataJSON() as { changes: Array<{ id: string; kind: 'archive' | 'pin'; expectedStateChangedAt: number; restoreAt?: number }> };
        const change = payload.changes[0]!;
        if (change.kind === 'archive' && change.expectedStateChangedAt === artifactArchivedRevision) {
          artifactArchivedAt = change.restoreAt === undefined ? undefined : new Date(change.restoreAt).toISOString();
          artifactArchivedRevision += 1;
        } else if (change.kind === 'pin' && change.expectedStateChangedAt === artifactPinnedRevision) {
          artifactPinnedAt = change.restoreAt === undefined ? undefined : new Date(change.restoreAt).toISOString();
          artifactPinnedRevision += 1;
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ undoneIds: [change.id], conflictIds: [] }) });
        return;
      }
      const payload = route.request().postDataJSON() as { ids: string[]; archived: boolean };
      bulkArchiveRequests.push(payload);
      const previousArchivedAt = artifactArchivedAt === undefined ? undefined : Date.parse(artifactArchivedAt);
      artifactArchivedAt = payload.archived ? '2026-09-26T15:00:00.000Z' : undefined;
      artifactArchivedRevision += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          archived: payload.archived,
          changedIds: payload.ids,
          artifacts: payload.ids.map((artifactId) => ({ artifactId, archived: payload.archived, archivedAt: artifactArchivedAt, archivedStateChangedAt: artifactArchivedRevision, previousArchivedAt })),
        }),
      });
      return;
    }
    artifactListRequestCount += 1;
    const wantsArchived = url.searchParams.get('archived') === 'true';
    const isInCurrentView = wantsArchived === (artifactArchivedAt !== undefined);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifacts: isInCurrentView ? [{ ...artifact, pinnedAt: artifactPinnedAt, archivedAt: artifactArchivedAt }] : [],
        total: isInCurrentView ? 1 : 0,
        totalBytes: 1024,
        maxBytes: 10240,
      }),
    });
  });

  const artifactResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/artifacts?') && response.ok());
  await page.goto('/?tab=home');
  await artifactResponse;
  await expect(page.locator('article').filter({ hasText: 'com.example.archive' })).toHaveCount(1);
  const listRequestsBeforeSingleArchive = artifactListRequestCount;
  await page.getByRole('button', { name: 'Archive com.example.archive' }).click();
  await expect(page.locator('article').filter({ hasText: 'com.example.archive' })).toHaveCount(0);
  await expect.poll(() => artifactListRequestCount).toBe(listRequestsBeforeSingleArchive + 1);
  await expect(page.locator('#artifact-archive-status')).toBeFocused();
  await expect(page.locator('#artifact-archive-announcement')).toHaveText('Archived com.example.archive.');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('article').filter({ hasText: 'com.example.archive' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Archive com.example.archive' }).click();
  await expect(page.locator('article').filter({ hasText: 'com.example.archive' })).toHaveCount(0);

  await page.getByRole('combobox', { name: /Active/ }).click();
  await page.getByRole('option', { name: 'Archived', exact: true }).click();
  const archivedArtifact = page.locator('article').filter({ hasText: 'com.example.archive' });
  await expect(archivedArtifact).toHaveCount(1);
  await expect(page.getByText('Archived items still use library storage and may be removed automatically unless pinned.')).toBeVisible();
  await archivedArtifact.getByRole('button', { name: 'Pin com.example.archive' }).click();
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  await expect(archivedArtifact.getByRole('button', { name: 'Restore com.example.archive' })).toBeVisible();
  const listRequestsBeforeRestore = artifactListRequestCount;
  await archivedArtifact.getByRole('button', { name: 'Restore com.example.archive' }).click();
  await expect(page.locator('article').filter({ hasText: 'com.example.archive' })).toHaveCount(0);
  await expect.poll(() => artifactListRequestCount).toBe(listRequestsBeforeRestore + 1);
  await expect(page.locator('#artifact-archive-status')).toBeFocused();
  await expect(page.locator('#artifact-archive-announcement')).toHaveText('Restored com.example.archive.');

  await page.getByRole('combobox', { name: /Archived/ }).click();
  await page.getByRole('option', { name: 'Active', exact: true }).click();
  const activeArtifact = page.locator('article').filter({ hasText: 'com.example.archive' });
  await expect(activeArtifact).toHaveCount(1);
  await page.getByRole('button', { name: 'Select items' }).click();
  await activeArtifact.getByRole('checkbox', { name: 'Select com.example.archive 2.4.0 (240)' }).check();
  const listRequestsBeforeBulkArchive = artifactListRequestCount;
  await page.getByRole('button', { name: 'Archive selected', exact: true }).click();
  await expect.poll(() => bulkArchiveRequests).toEqual([{ ids: ['archive-artifact'], archived: true }]);
  await expect(activeArtifact).toHaveCount(0);
  await expect.poll(() => artifactListRequestCount).toBe(listRequestsBeforeBulkArchive + 1);
  await expect(page.locator('#artifact-archive-status')).toBeFocused();
  await expect(page.locator('#artifact-archive-announcement')).toHaveText('Archived 1 artifact.');
  await page.getByRole('combobox', { name: /Active/ }).click();
  await page.getByRole('option', { name: 'Archived', exact: true }).click();
  await expect(archivedArtifact).toHaveCount(1);
  expect(artifactListRequestCount).toBeLessThan(20);
  await expectAccessible(page);
});

test('IPA Library scrolls within a compact viewport so jobs stay nearby', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let artifactListRequestCount = 0;
  const artifacts = Array.from({ length: 40 }, (_, index) => ({
    id: `scroll-artifact-${index}`,
    key: `com.example.scroll${index}:appstore:${index}`,
    projectIds: ['default'],
    bundleId: `com.example.scroll${index}`,
    channel: 'appstore' as const,
    versionLabel: '1.0.0',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    sourceJobId: `job-scroll-artifact-${index}`,
    warnings: [],
    fileUrl: `/v1/dashboard/artifacts/scroll-artifact-${index}/file`,
  }));
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts*', async (route) => {
    artifactListRequestCount += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts, total: artifacts.length, totalBytes: 40_960, maxBytes: 81_920 }),
    });
  });

  await page.goto('/?tab=home');
  const list = page.getByRole('region', { name: 'IPA library artifacts scroll area' });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const artifactScrollRange = await list.evaluate((element) => element.scrollHeight - element.clientHeight);
    const artifactViewportHeight = await list.evaluate((element) => element.clientHeight);
    expect(artifactScrollRange).toBeGreaterThan(0);
    expect(artifactViewportHeight).toBeLessThanOrEqual(viewport.height * 0.35 + 2);
    await expect(list.locator('[data-artifact-id="scroll-artifact-0"]')).toBeVisible();
    const activeJobsTop = await page.getByRole('heading', { name: 'Active jobs' }).evaluate((element) => element.getBoundingClientRect().top);
    expect(activeJobsTop).toBeLessThan(viewport.height + (viewport.width < 640 ? 120 : 0));
    const finalArtifact = list.locator('[data-artifact-id="scroll-artifact-39"]');
    await list.focus();
    await list.press('End');
    await expect(finalArtifact).toBeAttached();
    await expect.poll(() => finalArtifact.evaluate((element) => {
      const container = element.closest('[aria-label="IPA library artifacts scroll area"]');
      if (!container) return false;
      const row = element.getBoundingClientRect();
      const viewport = container.getBoundingClientRect();
      return row.bottom > viewport.top && row.top < viewport.bottom;
    })).toBe(true);
    await list.evaluate((element) => { element.scrollTop = 0; });
    await expect(list.locator('[data-artifact-id="scroll-artifact-0"]')).toBeInViewport();
  }
  await expect.poll(() => artifactListRequestCount).toBe(1);
});

test('IPA Library stays populated and does not refetch loaded results during incremental scrolling', async ({ page }) => {
  test.setTimeout(60_000);
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.stack ?? error.message));
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let artifactListRequestCount = 0;
  const warning = 'Payload/Example.app/Extensions/Share.appex/Share still encrypted (cryptid != 0)';
  const artifacts = Array.from({ length: 120 }, (_, index) => ({
    id: `wheel-scroll-artifact-${index}`,
    key: `com.example.wheel${index}:appstore:${index}`,
    projectIds: ['default'],
    bundleId: `com.example.wheel${index}`,
    channel: 'appstore' as const,
    versionLabel: '1.0.0',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    sourceJobId: `job-wheel-scroll-artifact-${index}`,
    warnings: index === 0 ? [warning] : [],
    fileUrl: `/v1/dashboard/artifacts/wheel-scroll-artifact-${index}/file`,
  }));
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== '/v1/dashboard/artifacts') {
      const id = pathname.split('/').at(-1);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(artifacts.find((entry) => entry.id === id)) });
      return;
    }
    artifactListRequestCount += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts, total: artifacts.length, totalBytes: 122_880, maxBytes: 245_760 }),
    });
  });

  const artifactResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/v1/dashboard/artifacts' && response.ok(),
  );
  await page.goto('/?tab=home');
  await artifactResponse;
  expect(runtimeErrors.filter((message) => message.includes('effect_update_depth_exceeded'))).toEqual([]);
  const viewport = page.getByRole('region', { name: 'IPA library artifacts scroll area' });
  const viewportHandle = await viewport.elementHandle();
  if (!viewportHandle) throw new Error('IPA Library artifacts viewport did not mount');
  const firstArtifact = viewport.locator('[data-artifact-id="wheel-scroll-artifact-0"]');
  await expect(viewport.locator('[role="listitem"]').first()).toHaveAttribute('aria-setsize', '120');
  await expect.poll(() => viewport.locator('[role="listitem"]').count()).toBeLessThan(120);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(runtimeErrors.filter((message) => message.includes('effect_update_depth_exceeded'))).toEqual([]);
  await firstArtifact.scrollIntoViewIfNeeded();
  await expect(firstArtifact).toBeVisible();
  await firstArtifact.getByRole('button', { name: 'Artifact details' }).click();
  await expect(page.getByRole('heading', { name: 'Artifact metadata' })).toBeVisible();
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close details' }).click();
  await viewportHandle.evaluate((element) => {
    const samples: Array<{ kind: 'blank' | 'detached'; scrollY: number; renderedRows: number }> = [];
    const browserWindow = window as typeof window & { __ipaLibraryScrollSamples?: typeof samples };
    browserWindow.__ipaLibraryScrollSamples = samples;
    const sample = () => {
      const region = element.getBoundingClientRect();
      const regionVisible = region.bottom > 0 && region.top < window.innerHeight;
      const rows = Array.from(element.querySelectorAll<HTMLElement>('[role="listitem"]'));
      const hasVisibleRow = rows.some((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > Math.max(region.top, 0) && bounds.top < Math.min(region.bottom, window.innerHeight);
      });
      if (!element.isConnected) samples.push({ kind: 'detached', scrollY: window.scrollY, renderedRows: rows.length });
      else if (regionVisible && !hasVisibleRow) samples.push({ kind: 'blank', scrollY: window.scrollY, renderedRows: rows.length });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const firstArtifactBounds = await firstArtifact.boundingBox();
  if (!firstArtifactBounds) throw new Error('First IPA Library artifact is not visible');
  await page.mouse.move(firstArtifactBounds.x + firstArtifactBounds.width / 2, firstArtifactBounds.y + firstArtifactBounds.height / 2);
  const scrollTopBeforeWheel = await viewport.evaluate((element) => element.scrollTop);
  const scrollYBeforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 360);
  await page.waitForTimeout(32);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollTopBeforeWheel);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBeforeWheel);
  for (const direction of [1, -1]) {
    let enteredLibrary = false;
    let checkedPositions = 0;
    for (let step = 0; step < 30; step += 1) {
      await page.mouse.wheel(0, direction * 800);
      await page.waitForTimeout(16);
      const sample = await viewportHandle.evaluate((element) => {
        const region = element.getBoundingClientRect();
        const regionVisible = region.bottom > 0 && region.top < window.innerHeight;
        if (!regionVisible) return { attached: element.isConnected, label: element.getAttribute('aria-label'), regionVisible, hasVisibleRow: true };
        const visibleTop = Math.max(region.top, 0);
        const visibleBottom = Math.min(region.bottom, window.innerHeight);
        const hasVisibleRow = Array.from(element.querySelectorAll<HTMLElement>('[role="listitem"]')).some((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.bottom > visibleTop && bounds.top < visibleBottom;
        });
        return { attached: element.isConnected, label: element.getAttribute('aria-label'), regionVisible, hasVisibleRow };
      });
      if (!sample.attached || sample.label !== 'IPA library artifacts scroll area') {
        const pageState = await page.locator('body').evaluate((element) => ({
          regions: Array.from(element.querySelectorAll<HTMLElement>('[role="region"]')).map((region) => ({
            label: region.getAttribute('aria-label'),
            visible: region.getBoundingClientRect().bottom > 0 && region.getBoundingClientRect().top < window.innerHeight,
          })),
          artifactRows: element.querySelectorAll('[data-artifact-id]').length,
          text: element.innerText.slice(0, 1200),
        }));
        throw new Error(`IPA Library viewport changed during scroll at direction ${direction}, step ${step}: ${JSON.stringify({ sample, artifactListRequestCount, pageState })}`);
      }
      if (sample.regionVisible) {
        enteredLibrary = true;
        checkedPositions += 1;
        expect(sample.hasVisibleRow).toBe(true);
      } else if (enteredLibrary) {
        break;
      }
    }
    expect(checkedPositions).toBeGreaterThan(0);
  }

  await firstArtifact.scrollIntoViewIfNeeded();
  await expect(firstArtifact).toBeAttached();
  await expect(firstArtifact.getByText('com.example.wheel0', { exact: true }).first()).toBeVisible();
  const scrollSamples = await page.evaluate(() => (window as typeof window & {
    __ipaLibraryScrollSamples?: Array<{ kind: 'blank' | 'detached'; scrollY: number; renderedRows: number }>;
  }).__ipaLibraryScrollSamples ?? []);
  expect(scrollSamples).toEqual([]);
  await expect.poll(() => artifactListRequestCount).toBe(1);
  expect(await viewport.locator('[role="listitem"]').count()).toBeLessThan(120);
  await expect(viewport.locator('[role="listitem"]').first()).toHaveAttribute('aria-setsize', '120');
  expect(runtimeErrors.filter((message) => message.includes('effect_update_depth_exceeded'))).toEqual([]);
});

test('IPA Library discards a page response from a source filter that is no longer active', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let beginOldPage!: () => void;
  let releaseOldPage!: () => void;
  const oldPageStarted = new Promise<void>((resolve) => {
    beginOldPage = resolve;
  });
  const oldPageGate = new Promise<void>((resolve) => {
    releaseOldPage = resolve;
  });
  const artifact = (id: string, bundleId: string, channel: 'appstore' | 'testflight') => ({
    id,
    key: `${bundleId}:${channel}:${id}`,
    projectIds: ['default'],
    bundleId,
    channel,
    versionLabel: '1.0.0',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    sourceJobId: `job-${id}`,
    warnings: [],
    fileUrl: `/v1/dashboard/artifacts/${id}/file`,
  });
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts*', async (route) => {
    const requestUrl = new URL(route.request().url());
    const channel = requestUrl.searchParams.get('channel');
    if (requestUrl.searchParams.get('cursor') === 'appstore-older') {
      beginOldPage();
      await oldPageGate;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ artifacts: [artifact('old-appstore', 'com.example.old-page', 'appstore')], total: 2, totalBytes: 2048, maxBytes: 4096 }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(channel === 'testflight'
        ? { artifacts: [artifact('current-testflight', 'com.example.current-testflight', 'testflight')], total: 1, totalBytes: 1024, maxBytes: 4096 }
        : { artifacts: [artifact('initial-appstore', 'com.example.initial', 'appstore')], total: 2, totalBytes: 2048, maxBytes: 4096, nextCursor: 'appstore-older' }),
    });
  });

  const initialArtifactResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/v1/dashboard/artifacts' && response.ok(),
  );
  await page.goto('/?tab=home');
  await initialArtifactResponse;
  await expect(page.locator('[data-artifact-id="initial-appstore"]')).toHaveCount(1);
  await page.getByRole('button', { name: /Load more/ }).click();
  await oldPageStarted;
  await page.getByRole('combobox', { name: 'All sources' }).click();
  await page.getByRole('option', { name: 'TestFlight', exact: true }).click();
  await expect(page.locator('[data-artifact-id="current-testflight"]')).toHaveCount(1);
  releaseOldPage();
  await expect(page.locator('[data-artifact-id="old-appstore"]')).toHaveCount(0);
});

test('date and number format preference is saved and restored from the account', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  const preferenceUpdates: Array<Record<string, unknown>> = [];
  let savedFormattingLocale = 'en';
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ formattingLocale: savedFormattingLocale, theme: 'dark', accent: 'violet', sound: true }),
      });
      return;
    }
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    preferenceUpdates.push(patch);
    if (typeof patch.formattingLocale === 'string') savedFormattingLocale = patch.formattingLocale;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ formattingLocale: savedFormattingLocale }) });
  });
  await page.route('**/v1/billing', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        provider: 'stripe',
        environment: 'live',
        managedPayments: true,
        missingConfiguration: [],
        plans: [{ id: 'regular', name: 'Regular', description: 'Standard access', amount: 5, currency: 'EUR', priceId: 'price_regular' }],
        legacyBilling: false,
        entitlement: { planId: 'viewer', decrypt: true, api: false, priority: 0 },
        providers: {
          stripe: { enabled: true, ready: true, environment: 'live' },
          crypto: { enabled: false, ready: false, environment: 'live', provider: 'nowpayments', assets: [] },
        },
      }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  const locale = page.getByLabel('Date and number format');
  await expect(locale).toHaveValue('en');
  await locale.selectOption('de');

  await expect.poll(() => preferenceUpdates).toEqual([{ formattingLocale: 'de' }]);
  await page.keyboard.press('Escape');
  const expectedPrice = await page.evaluate(() => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(5));
  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  await expect(page.getByText(expectedPrice, { exact: true })).toBeVisible();

  await page.evaluate(() => localStorage.removeItem('formattingLocale'));
  await page.reload();
  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  await expect(page.getByText(expectedPrice, { exact: true })).toBeVisible();

  const checkedAt = '2026-09-27T00:30:00.000Z';
  await page.route('**/v1/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'operational',
        checkedAt,
        deployment: { ref: 'abcdef0123456789' },
        components: {
          service: { state: 'operational' },
          automation: { state: 'operational' },
          scheduler: { state: 'operational' },
        },
      }),
    });
  });
  await page.goto('/status');
  const expectedCheckedAt = await page.evaluate((value) => new Intl.DateTimeFormat('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value)), checkedAt);
  await expect(page.getByText(expectedCheckedAt, { exact: false })).toBeVisible();
});

test('automatic date formatting follows system language changes', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] });
  });
  const checkedAt = '2026-09-27T00:30:00.000Z';
  await page.route('**/v1/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'operational',
        checkedAt,
        deployment: { ref: 'abcdef0123456789' },
        components: {
          service: { state: 'operational' },
          automation: { state: 'operational' },
          scheduler: { state: 'operational' },
        },
      }),
    });
  });

  await page.goto('/status');
  const formatCheckedAt = (locale: string) => page.evaluate((input) => new Intl.DateTimeFormat(input.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(input.checkedAt)), { locale, checkedAt });
  const englishCheckedAt = await formatCheckedAt('en-US');
  const germanCheckedAt = await formatCheckedAt('de-DE');
  await expect(page.getByText(englishCheckedAt, { exact: false })).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['de-DE'] });
    window.dispatchEvent(new Event('languagechange'));
  });

  await expect(page.getByText(germanCheckedAt, { exact: false })).toBeVisible();
  await expect(page.getByText(englishCheckedAt, { exact: false })).not.toBeVisible();
});

test('accounts without a saved format preference do not inherit the previous browser choice', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('formattingLocale', 'de'));
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();

  await expect(page.getByLabel('Date and number format')).toHaveValue('system');
});

test('active jobs table supports keyboard scrolling on constrained viewports', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 812 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [{
          id: 'job-keyboard-scroll',
          bundleId: 'com.example.keyboard-scroll',
          source: 'App Store',
          status: 'queued',
          progress: 'Waiting for a device',
          createdAt: '2026-09-27T00:00:00.000Z',
          priority: 0,
          queuedBy: 'member',
          versionLabel: '1.0',
        }],
      }),
    });
  });

  await page.goto('/');

  const region = page.getByRole('region', { name: 'Active jobs table scroll area' });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('tabindex', '0');
  await region.scrollIntoViewIfNeeded();
  await expect.poll(() => region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await region.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.press('End');
  await expect.poll(() => region.evaluate((element) => element.scrollLeft === element.scrollWidth - element.clientWidth)).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBe(0);
});

test('automation managers can inspect queue objective breaches in Insights', async ({ page }) => {
  await page.clock.install();
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '4294967296');
  await page.route('**/v1/dashboard/insights*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        totalRuns: 0,
        doneCount: 0,
        failedCount: 0,
        successRate: 0,
        totalSizeBytes: 0,
        manualCount: 0,
        systemCount: 0,
        topApps: [],
        trend: [],
        failureBreakdown: [],
        byDevice: [],
        anomalies: [],
      }),
    });
  });
  let sloRequests = 0;
  let elapsedBreach = false;
  await page.route('**/v1/dashboard/jobs/slo*', async (route) => {
    sloRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        targetMs: 300_000,
        historicalP95Ms: 120_000,
        jobs: [{
          id: 'job-slo-1',
          bundleId: 'com.example.slo',
          status: 'queued',
          waitedMs: elapsedBreach ? 301_000 : 70_000,
          predictedStartMs: elapsedBreach ? null : 120_000,
          predictedCompletionMs: elapsedBreach ? null : 240_000,
          parallelism: 2,
          objective: 'breached',
        }],
      }),
    });
  });
  await page.route('**/v1/dashboard/failure-patterns*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ patterns: [] }) });
  });
  await page.route('**/v1/dashboard/storage-forecast*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ freeBytes: 0, bytesPerDay: 0, daysRemaining: null, sampleCount: 0 }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Insights', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Queue objective' })).toBeVisible();
  await expect(page.getByText('Projected late', { exact: true })).toBeVisible();
  await expect(page.getByText(/best-case total/)).toBeVisible();
  const initialRequests = sloRequests;
  elapsedBreach = true;
  await page.clock.fastForward(30_000);
  await expect.poll(() => sloRequests).toBeGreaterThan(initialRequests);
  await expect(page.getByText('Objective missed', { exact: true })).toBeVisible();
});

test('queue objective details stay hidden from members without automation access', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  let sloRequests = 0;
  await page.route('**/v1/dashboard/jobs/slo*', async (route) => {
    sloRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ targetMs: 300_000, historicalP95Ms: null, jobs: [] }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Insights', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Queue objective' })).toHaveCount(0);
  expect(sloRequests).toBe(0);
});

test('batch TestFlight queue selects an eligible device independently for each app', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  await page.route('**/v1/billing', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ providers: { stripe: { enabled: false }, crypto: { enabled: false } } }),
    });
  });
  const verifiedAt = Date.now();
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    const bundleIds = new URL(route.request().url()).searchParams.get('bundleIds')?.split(',') ?? [];
    const names: Record<string, string> = {
      'com.example.testflight': 'Example Beta',
      'com.example.other': 'Other Beta',
    };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ entries: bundleIds.filter((bundleId) => names[bundleId]).map((bundleId) => ({ bundleId, displayName: names[bundleId], displayNameLanguage: 'en', metadataFetchedAt: Date.now(), updatedAt: Date.now() })) }),
    });
  });
  await page.route('**/v1/dashboard/testflight/catalog*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [
          {
            appId: 12345,
            bundleId: 'com.example.testflight',
            displayName: 'Example Beta',
            devices: [
              { id: 'device-1', name: 'Test iPad', verifiedAt },
              { id: 'device-2', name: 'Alternate iPad', verifiedAt },
            ],
            lastVerifiedAt: verifiedAt,
            deviceSource: true,
          },
          {
            appId: 54321,
            bundleId: 'com.example.other',
            displayName: 'Other Beta',
            devices: [{ id: 'device-3', name: 'Third iPad', verifiedAt }],
            lastVerifiedAt: verifiedAt,
            deviceSource: true,
          },
        ],
        fetchedAt: Date.now(),
      }),
    });
  });
  await page.route('**/v1/dashboard/testflight/*/trains*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ trains: [{ trainVersion: '2.4.1', buildCount: 1 }] }) });
  });
  await page.route('**/v1/dashboard/testflight/*/builds*', async (route) => {
    const appId = Number(new URL(route.request().url()).pathname.split('/').at(-2));
    const bundleId = appId === 12345 ? 'com.example.testflight' : 'com.example.other';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ builds: [{ id: appId, bundleId, cfBundleShortVersion: '2.4.1', cfBundleVersion: '123' }] }),
    });
  });
  const queuedRequests: Record<string, unknown>[] = [];
  await page.route('**/v1/dashboard/testflight/decrypt', async (route) => {
    queuedRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: `job-testflight-batch-${queuedRequests.length}`, status: 'queued', progress: 'Queued', queue: { position: queuedRequests.length, total: 2 } }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Batch decrypt' }).first().click();
  await page.getByRole('button', { name: 'TestFlight', exact: true }).click();
  await page.getByPlaceholder('com.example.app@2.4.1_123\ncom.example.app2@3.0_456').fill('com.example.testflight@2.4.1_123\ncom.example.other@2.4.1_123');
  const eligibleDevice = page.getByRole('combobox', { name: 'Eligible device for Example Beta' });
  await expect(eligibleDevice).toBeVisible();
  await eligibleDevice.click();
  await page.getByRole('option', { name: 'Alternate iPad' }).click();
  await expect(page.getByText('Third iPad', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Queue all' }).click();

  await expect.poll(() => queuedRequests).toHaveLength(2);
  expect(queuedRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({
      bundleId: 'com.example.testflight',
      appId: 12345,
      deviceId: 'device-2',
      build: expect.objectContaining({ id: 12345, cfBundleShortVersion: '2.4.1', cfBundleVersion: '123' }),
    }),
    expect.objectContaining({
      bundleId: 'com.example.other',
      appId: 54321,
      deviceId: 'device-3',
      build: expect.objectContaining({ id: 54321, cfBundleShortVersion: '2.4.1', cfBundleVersion: '123' }),
    }),
  ]));
  await expect(page.getByText('com.example.testflight@2.4.1_123', { exact: true })).toBeVisible();
  await expect(page.getByText('Queued 2 of 2', { exact: true })).toBeHidden({ timeout: 10_000 });
  await expectAccessible(page);
});

test('batch paste resolves App Store links and never auto-subscribes TestFlight invites', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, (2n | (1n << 34n)).toString());
  const queued: string[] = [];
  let inviteRequests = 0;
  await page.route('**/v1/dashboard/apps/lookup-track?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ bundleId: 'com.example.linked', trackName: 'Linked', trackId: 123456789 }) });
  });
  await page.route('**/v1/dashboard/decrypt', async (route) => {
    queued.push((route.request().postDataJSON() as { bundleId: string }).bundleId);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: `job-${queued.length}`, status: 'queued', progress: 'Queued', queue: { position: 1, total: 1 } }) });
  });
  await page.route('**/v1/dashboard/testflight/subscriptions', async (route) => {
    if (route.request().method() === 'POST') {
      inviteRequests += 1;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { subscription: { id: 'invite-1', status: 'pending' } } }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ subscriptions: [], total: 0 }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Batch decrypt' }).first().click();
  await page.getByRole('button', { name: 'Paste links' }).click();
  await page.getByPlaceholder('com.example.app\nhttps://apps.apple.com/us/app/example/id123456789\nhttps://testflight.apple.com/join/ABC123').fill('com.example.bundle\nhttps://apps.apple.com/us/app/linked/id123456789\nhttps://testflight.apple.com/join/ABC123');
  await page.getByRole('button', { name: 'Add rows' }).click();
  await expect(page.getByText('TestFlight invite · requires a separate request')).toBeVisible();
  expect(inviteRequests).toBe(0);
  await page.getByRole('button', { name: 'Request access' }).click();
  await expect.poll(() => inviteRequests).toBe(1);
  await page.getByRole('button', { name: 'Queue 2 App Store apps' }).click();
  await expect.poll(() => queued).toEqual(['com.example.bundle', 'com.example.linked']);
  expect(inviteRequests).toBe(1);
});

test('busy device verification opens the queue review without labeling the device offline', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  await page.route('**/v1/dashboard/search?q=*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ bundleId: 'com.myfitnesspal.mfp', trackName: 'MyFitnessPal', trackId: 123, price: 0 }] }) });
  });
  await page.route('**/v1/dashboard/decrypt/preflight', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      bundleId: 'com.myfitnesspal.mfp',
      testflight: false,
      queueLength: 0,
      canQueue: false,
      devices: [{ id: 'busy-ipad', name: 'Busy iPad', isPrimary: true, ready: false, checking: true, blockers: ['Device health check is still running. Try again shortly.'] }],
    }) });
  });

  await page.goto('/?tab=home');
  await page.getByPlaceholder('Search the App Store to decrypt… (press / to focus)').fill('MyFitnessPal');
  await page.getByRole('button', { name: 'Decrypt', exact: true }).click();
  await expect(page.getByText('Device health check is still running. Try again shortly.')).toBeVisible();
  await expect(page.getByText('Device verification is still running. You can queue now; the worker will recheck before starting.')).toBeVisible();
  await expect(page.getByText('Device unreachable')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Queue anyway' })).toBeVisible();
  await expectAccessible(page);
});

test('batch queue retries only failed entries after a partial success', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  await page.route('**/v1/billing', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ providers: { stripe: { enabled: false }, crypto: { enabled: false } } }),
    });
  });
  const attempts: string[] = [];
  await page.route('**/v1/dashboard/decrypt', async (route) => {
    const body = route.request().postDataJSON() as { bundleId: string };
    attempts.push(body.bundleId);
    if (body.bundleId === 'com.example.retry' && attempts.filter((bundleId) => bundleId === body.bundleId).length === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id: `job-${body.bundleId}`, status: 'queued', progress: 'Queued', queue: { position: 1, total: 1 } }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Batch decrypt' }).first().click();
  await page.getByPlaceholder('com.example.app\ncom.example.app2@version_123').fill('com.example.retry\ncom.example.success');
  await page.getByRole('button', { name: 'Queue all' }).click();
  await expect(page.getByRole('button', { name: 'Retry 1 failed' })).toBeVisible();
  expect(attempts).toEqual(['com.example.retry', 'com.example.success']);

  await page.getByRole('button', { name: 'Retry 1 failed' }).click();
  await expect.poll(() => attempts).toEqual(['com.example.retry', 'com.example.success', 'com.example.retry']);
  await expect(page.getByTitle('com.example.success@')).toBeVisible();
  await expect(page.getByText('Queued 1 of 1', { exact: true })).toBeHidden({ timeout: 10_000 });
  await expectAccessible(page);
});

test('batch queue exports each result and error as a CSV download', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  const attempts: string[] = [];
  await page.route('**/v1/dashboard/decrypt', async (route) => {
    const body = route.request().postDataJSON() as { bundleId: string };
    attempts.push(body.bundleId);
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'job-com.example.success', status: 'queued', progress: 'Queued', queue: { position: 1, total: 1 } }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Batch decrypt' }).first().click();
  await page.getByPlaceholder('com.example.app\ncom.example.app2@version_123').fill('com.example.fail@bad"id\ncom.example.formula@=1+1\ncom.example.success@version_2');
  await page.getByRole('button', { name: 'Queue all' }).click();
  await expect(page.getByRole('button', { name: 'Retry 2 failed' })).toBeVisible();
  await expect(page.getByText('Queued 1 of 2', { exact: true })).toBeHidden({ timeout: 10_000 });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export results' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('dkrypt-batch-results.csv');
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  expect(await readFile(downloadPath!, 'utf8')).toBe([
    '"bundle_id","selector","status","job_id","error"',
    '"com.example.fail","bad""id","failed","","invalid App Store version ID"',
    '"com.example.formula","\'=1+1","failed","","invalid App Store version ID"',
    '"com.example.success","version_2","queued","job-com.example.success",""',
  ].join('\r\n') + '\r\n');
  expect(attempts).toEqual(['com.example.success']);
  await expectAccessible(page);
});

test('pricing plan checkout actions share a bottom baseline', async ({ page }) => {
  await mockPublicPricing(page);
  for (const width of [1264, 1280, 1365, 1440, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/pricing');

    const buttons = page.getByRole('link', { name: 'Sign in to subscribe' });
    const paymentDetails = page.getByText('Stripe checkout · crypto where available', { exact: true });
    await expect(buttons).toHaveCount(6);
    await expect(paymentDetails).toHaveCount(6);
    const cardLayout = await page.locator('main > div.grid > [data-slot="card"]').evaluateAll((cards) => cards.map((card) => {
      const rect = card.getBoundingClientRect();
      const button = card.querySelector('a[href="/#sign-in"]');
      const price = card.querySelector('.text-3xl');
      const paymentDetails = [...card.querySelectorAll('div')].find((element) => element.textContent?.trim() === 'Stripe checkout · crypto where available');
      return {
        top: rect.top,
        buttonBottom: button?.getBoundingClientRect().bottom ?? Number.NaN,
        buttonWidth: button?.getBoundingClientRect().width ?? Number.NaN,
        priceTop: price?.getBoundingClientRect().top ?? Number.NaN,
        paymentDetailsTop: paymentDetails?.getBoundingClientRect().top ?? Number.NaN,
        paymentDetailsWidth: paymentDetails?.getBoundingClientRect().width ?? Number.NaN,
      };
    }));
    const rows = new Map<number, typeof cardLayout>();
    for (const card of cardLayout) {
      const rowTop = [...rows.keys()].find((top) => Math.abs(top - card.top) <= 2) ?? card.top;
      rows.set(rowTop, [...(rows.get(rowTop) ?? []), card]);
    }
    for (const row of rows.values()) {
      for (const key of ['buttonBottom', 'priceTop', 'paymentDetailsTop'] as const) {
        const positions = row.map((card) => card[key]);
        expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(2);
      }
      expect(row.every((card) => Math.abs(card.buttonWidth - card.paymentDetailsWidth) <= 2)).toBe(true);
    }
  }
});

test('settings panels load on first visit and remain mounted after revisiting', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let doctorRequests = 0;
  let roleRequests = 0;
  await page.route('**/v1/dashboard/doctor', async (route) => {
    doctorRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        checkedAt: '2026-10-02T12:00:00.000Z',
        deployment: { id: 'run-lazy-settings-1', ref: 'abcdef0123456789' },
        checks: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/roles', async (route) => {
    roleRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ roles: [] }) });
  });
  await page.route('**/v1/dashboard/users', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ users: [] }) });
  });
  await page.route('**/v1/dashboard/discord/status', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ botEnabled: false, guilds: [] }) });
  });

  const overviewLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/dashboard/overview');
  await page.goto('/?tab=settings&stab=scheduler');
  await overviewLoaded;
  await waitForBrowserFrames(page);
  const groups = page.getByRole('navigation', { name: 'Settings groups' });
  await expect(groups.getByRole('button', { name: 'Operations' })).toBeVisible();
  expect(doctorRequests).toBe(0);
  expect(roleRequests).toBe(0);

  await groups.getByRole('button', { name: 'System' }).click();
  const doctorHeading = page.locator('h2').filter({ hasText: 'System doctor' });
  await expect(doctorHeading).toBeVisible();
  await expect.poll(() => doctorRequests).toBeGreaterThan(0);
  const doctorRequestsAfterFirstVisit = doctorRequests;

  await groups.getByRole('button', { name: 'Operations' }).click();
  await expect(doctorHeading).toBeAttached();
  await expect(doctorHeading).toBeHidden();
  await groups.getByRole('button', { name: 'System' }).click();
  await expect(doctorHeading).toBeVisible();
  await waitForBrowserFrames(page);
  expect(doctorRequests).toBe(doctorRequestsAfterFirstVisit);

  await groups.getByRole('button', { name: 'Team' }).click();
  await page.getByRole('navigation', { name: 'Team settings' }).getByRole('button', { name: 'Roles' }).click();
  await expect.poll(() => roleRequests).toBeGreaterThan(0);
  const rolesDescription = page.getByText('Every signed-in user automatically holds');
  await expect(rolesDescription).toBeVisible();
  const roleRequestsAfterFirstVisit = roleRequests;
  await groups.getByRole('button', { name: 'Operations' }).click();
  await expect(rolesDescription).toBeAttached();
  await expect(rolesDescription).toBeHidden();
  await groups.getByRole('button', { name: 'Team' }).click();
  await page.getByRole('navigation', { name: 'Team settings' }).getByRole('button', { name: 'Roles' }).click();
  await expect(rolesDescription).toBeVisible();
  await waitForBrowserFrames(page);
  expect(roleRequests).toBe(roleRequestsAfterFirstVisit);
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await groups.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.getByRole('navigation', { name: 'Team settings' }).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('operations panels stay out of the Home layout and remain reachable in Insights', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.goto('/?tab=home');
  await expect(page.getByRole('main').getByText('Action Center', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByText('Incident timeline', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Insights', exact: true }).click();
  await expect(page.getByText('Operations · Action Center and incident timeline')).toBeVisible();
});

test('device comparison keeps unknown readings distinct from unhealthy readings', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.unroute('**/v1/dashboard/overview*');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      schedulerEnabled: false,
      settings: {},
      watches: [],
      schedulerRunHistory: [],
      disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
      isPaidPlan: false,
      maintenance: { active: false, manual: false, auto: false },
      activeJobs: [],
      devices: [
        { id: 'ipad-a', name: 'Studio iPad', transport: 'usb', productType: 'iPad13,4', iosVersion: '17.4', enabled: true, createdAt: 1, updatedAt: 1 },
        { id: 'ipad-b', name: 'Travel iPad', transport: 'wifi', productType: 'iPad8,1', iosVersion: '16.7', enabled: true, createdAt: 1, updatedAt: 1 },
      ],
    }) });
  });
  await page.route('**/v1/dashboard/devices/*/health*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[4];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(id === 'ipad-a'
      ? { reachable: true, batteryPercent: 72, storageFreeBytes: 10_000_000_000, readiness: { state: 'ready', score: 95, reasons: [] }, checkedAt: Date.now() }
      : { reachable: false, error: 'Wi-Fi connection timed out', checkedAt: Date.now() }) });
  });
  let auditRequests = 0;
  await page.route('**/v1/dashboard/audit-log/target/ipad-a', async (route) => {
    auditRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [{ id: 'audit-a', ts: Date.now(), actor: 'operator-a', action: 'device.update', target: 'ipad-a', changes: [{ field: 'enabled', before: true, after: false }] }] }) });
  });
  const deviceEdits: Array<{ expectedUpdatedAt?: number; name?: string }> = [];
  await page.route('**/v1/dashboard/devices/ipad-a', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const payload = route.request().postDataJSON() as { expectedUpdatedAt?: number; name?: string };
    deviceEdits.push(payload);
    if (deviceEdits.length === 1) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'revision_conflict', error: 'device changed in another session', message: 'device changed in another session', requestId: 'conflict-1', retryable: false, remediation: { current: { id: 'ipad-a', name: 'Saved by another operator', transport: 'usb', enabled: true, updatedAt: 2 } } }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'ipad-a', name: payload.name, transport: 'usb', enabled: true, updatedAt: 3 }) });
  });
  await page.goto('/?tab=settings&stab=devices');
  await page.getByRole('button', { name: 'Compare devices' }).click();
  const comparison = page.getByRole('region', { name: 'Device comparison' });
  await expect(comparison).toContainText('Studio iPad');
  await expect(comparison).toContainText('Travel iPad');
  await expect(comparison).toContainText('72%');
  await expect(comparison).toContainText('Not checked');
  expect(auditRequests).toBe(0);
  await page.locator('#device-ipad-a').getByText('Who changed this?').click();
  await expect(page.locator('#device-ipad-a')).toContainText('operator-a');
  expect(auditRequests).toBe(1);
  await page.getByRole('button', { name: 'Edit Studio iPad' }).click();
  await page.getByLabel('Name', { exact: true }).fill('My revised name');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('region', { name: 'Device edit conflict' })).toContainText('Saved by another operator');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('My revised name');
  await page.getByRole('button', { name: 'Apply my edits to latest' }).click();
  expect(deviceEdits.map((edit) => edit.expectedUpdatedAt)).toEqual([1, 2]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(comparison).toBeVisible();
  expect(await comparison.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('interrupted device setup remains available after navigation and can resume', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let resumed = false;
  const operation = { id: 'setup-operation-1', status: 'interrupted', stage: 'connecting', stages: [{ id: 'connecting', label: 'Connecting and checking the device', at: Date.now(), status: 'failed' }], error: 'Setup was interrupted. Reconnect the device and resume setup.', createdAt: Date.now(), updatedAt: Date.now() };
  await page.route('**/v1/dashboard/devices/setup-operations**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/resume')) {
      resumed = true;
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ operation: { ...operation, status: 'running', error: undefined } }) });
      return;
    }
    if (url.pathname.endsWith('/setup-operations')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operations: [operation] }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation }) });
  });
  await page.route('**/v1/dashboard/devices/discover', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ devices: [], scannedNetworks: [], warnings: [] }) }));
  await page.goto('/?tab=settings&stab=devices');
  await page.getByRole('button', { name: 'Background tasks' }).click();
  await expect(page.getByRole('dialog')).toContainText('Device setup');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Continue setup' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue setup' }).click();
  await expect(page.getByRole('dialog')).toContainText('Connecting and checking the device');
  await page.getByRole('dialog').getByRole('button', { name: 'Try again' }).click();
  expect(resumed).toBe(true);
});

test('incident time view labels gaps before recorded transitions', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/incidents?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ projectId: 'default', events: [], truncated: false }) });
  });
  await page.route('**/v1/dashboard/action-center?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ projectId: 'default', incidents: [] }) });
  });
  await page.route('**/v1/dashboard/incidents/state-at?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ projectId: 'default', at: Date.now(), coverage: 'incomplete', coverageStartAt: Date.now() - 86_400_000, incidents: [] }) });
  });
  await page.goto('/?tab=insights');
  await page.getByText('Operations · Action Center and incident timeline').click();
  await page.getByRole('button', { name: 'Explore time' }).click();
  await expect(page.getByRole('region', { name: 'Incident state at a time' })).toContainText('History before');
  await expect(page.getByRole('slider', { name: /Recorded state at/ })).toBeVisible();
});

test('self-hosters can review configuration doctor checks from Settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(pathname === '/v1/billing' ? { providers: { stripe: { enabled: false }, crypto: { enabled: false } } } : {}),
    });
  });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let doctorRequests = 0;
  await page.route('**/v1/dashboard/doctor', async (route) => {
    doctorRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: doctorRequests > 1,
        checkedAt: '2026-09-27T12:00:00.000Z',
        checks: doctorRequests > 1 ? [
          { id: 'database', status: 'ok', detail: 'SQLite schema 12 is intact' },
        ] : [
          { id: 'database', status: 'ok', detail: 'SQLite schema 12 is intact' },
          { id: 'session-secret-rotation', status: 'warn', detail: 'No overlapping previous credential is configured' },
          { id: 'device-bridge', status: 'error', detail: 'Rust device bridge socket is not available yet' },
        ],
        deployment: { id: 'run-doctor-1', ref: 'abcdef0123456789' },
      }),
    });
  });

  await page.goto('/?tab=settings&stab=doctor');

  await expect(page.getByRole('heading', { name: 'System doctor' })).toBeVisible();
  await expect(page.getByText('run-doctor-1')).toBeVisible();
  await expect(page.getByText('abcdef0123456789')).toBeVisible();
  await expect(page.getByText('Configuration needs attention')).toBeVisible();
  await expect(page.getByText('SQLite schema 12 is intact')).toBeVisible();
  await expect(page.getByText('Rust device bridge socket is not available yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh checks' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download support bundle' })).toHaveAttribute('href', '/v1/dashboard/support-bundle');
  expect(doctorRequests).toBe(1);
  await page.getByRole('button', { name: 'Refresh checks' }).click();
  await expect(page.getByText('All checks passed')).toBeVisible();
  expect(doctorRequests).toBe(2);
  const dimensions = await page.evaluate(() => ({ bodyWidth: document.body.scrollWidth, viewportWidth: document.documentElement.clientWidth }));
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  await expectAccessible(page);
});

test('system doctor is hidden from accounts without device-management permission', async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(pathname === '/v1/billing' ? { providers: { stripe: { enabled: false }, crypto: { enabled: false } } } : {}),
    });
  });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2097152');
  let doctorRequests = 0;
  await page.route('**/v1/dashboard/doctor', async (route) => {
    doctorRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, checkedAt: '2026-09-27T12:00:00.000Z', deployment: { id: 'run-device-1', ref: 'abcdef0123456789' }, checks: [] }) });
  });

  await page.goto('/?tab=settings&stab=doctor');

  await expect(page.getByRole('button', { name: 'Operations', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'System', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Operations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
  expect(doctorRequests).toBe(0);
});

test('status panel handles an unavailable job volume response without an unhandled rejection', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  await page.addInitScript(() => {
    const target = window as typeof window & { jobVolumeRejections: string[] };
    target.jobVolumeRejections = [];
    window.addEventListener('unhandledrejection', (event) => {
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
      if (message.includes('job volume unavailable') || message.includes("reading 'map'")) target.jobVolumeRejections.push(message);
    });
  });
  let volumeRequests = 0;
  await page.route('**/v1/dashboard/jobs/volume*', async (route) => {
    volumeRequests += 1;
    if (volumeRequests === 1) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
      return;
    }
    if (volumeRequests === 2) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'job volume unavailable' }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ days: [{ date: '2026-10-01', count: 3 }] }),
    });
  });

  const volumeResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/dashboard/jobs/volume');
  await page.goto('/?tab=home');
  expect((await volumeResponse).status()).toBe(200);
  expect(volumeRequests).toBe(1);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await page.getByRole('button', { name: 'Open status drawer' }).click();
  const statusDrawer = page.getByRole('complementary', { name: 'Status drawer' });
  await expect(statusDrawer.getByText('Decrypt activity unavailable')).toBeVisible();

  const failedRetry = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/dashboard/jobs/volume');
  await statusDrawer.getByRole('button', { name: 'Retry decrypt history' }).click();
  expect((await failedRetry).status()).toBe(503);
  expect(volumeRequests).toBe(2);
  await expect(statusDrawer.getByText('Decrypt activity unavailable')).toBeVisible();

  const recoveredRetry = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/dashboard/jobs/volume');
  await statusDrawer.getByRole('button', { name: 'Retry decrypt history' }).click();
  expect((await recoveredRetry).status()).toBe(200);
  await expect(statusDrawer.getByText('3 decrypts · last 14 days')).toBeVisible();
  expect(volumeRequests).toBe(3);

  const failures = await page.evaluate(() => (window as typeof window & { jobVolumeRejections: string[] }).jobVolumeRejections);
  expect(failures).toEqual([]);
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
});

test('device managers can run on-demand service health checks', async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(pathname === '/v1/billing' ? { providers: { stripe: { enabled: false }, crypto: { enabled: false } } } : {}),
    });
  });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/doctor', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, checkedAt: '2026-09-27T12:00:00.000Z', deployment: { id: 'run-device-2', ref: 'abcdef0123456789' }, checks: [] }) });
  });
  let probeRequests = 0;
  await page.route('**/v1/dashboard/synthetic', async (route) => {
    probeRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        checkedAt: '2026-09-27T12:01:00.000Z',
        probes: [
          { id: 'database', status: 'ok', durationMs: 14, detail: 'SQLite integrity is clean' },
          { id: 'device-agent', status: 'error', durationMs: 340, detail: 'The device agent did not respond' },
        ],
      }),
    });
  });
  await page.route('**/v1/dashboard/browser-check', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      cookieSessionValid: true,
      expectedOrigin: 'http://127.0.0.1:4173',
      observedOrigin: 'http://127.0.0.1:4173',
      forwardedHeadersPresent: false,
      oauthCallbacks: { github: 'http://127.0.0.1:4173/v1/auth/github/callback', discord: 'Not configured' },
    }) });
  });

  await page.goto('/?tab=settings&stab=doctor');
  await expect(page.getByRole('heading', { name: 'System doctor' })).toBeVisible();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByText('TestFlight uses its last device verification and is never opened or refreshed.')).toBeVisible();
  expect(probeRequests).toBe(0);
  await page.getByRole('button', { name: 'Run health checks' }).click();

  await expect(page.getByText('Service health checks')).toBeVisible();
  await expect(page.getByText('SQLite integrity is clean')).toBeVisible();
  await expect(page.getByText('The device agent did not respond')).toBeVisible();
  expect(probeRequests).toBe(1);
  await page.getByRole('button', { name: 'Run browser checks' }).click();
  await expect(page.getByRole('region', { name: 'Self-hosting browser check' })).toContainText('PUBLIC_BASE_URL matches this browser.');
  await expect(page.getByRole('region', { name: 'Self-hosting browser check' })).toContainText('Confirm the provider dashboard has this exact callback URL');
  await expectAccessible(page);
});

test('Apple Account save submits its form and shows the saved state', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  const status = {
    enabled: false,
    ready: false,
    downloaderAvailable: false,
    decryptorAvailable: false,
    fairPlayAuthorized: false,
    vault: { encryptionReady: true, accountConfigured: false, credentialConfigured: false },
    blockers: ['Apple Account credentials are not configured'],
    credentialRetrieval: { state: 'idle' },
  };
  await page.route('**/v1/dashboard/appstore-offline/status', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(status) });
  });
  await page.route('**/v1/dashboard/devices*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ devices: [] }) });
  });
  let saveRequests = 0;
  await page.route('**/v1/dashboard/appstore-offline/account', async (route) => {
    if (route.request().method() !== 'PUT') return route.fulfill({ status: 404 });
    saveRequests += 1;
    const submitted = route.request().postDataJSON() as { appleId: string; password: string };
    expect(submitted.appleId).toBe('apple@example.test');
    expect(submitted.password).toBe('test-only-password');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...status, vault: { ...status.vault, accountConfigured: true, accountHint: 'configured' }, blockers: [] }),
    });
  });

  await page.goto('/?tab=settings&stab=doctor');
  await page.getByLabel('Apple Account email').fill('apple@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password');
  await page.getByRole('button', { name: 'Save account' }).click();

  await expect(page.locator('[role="status"]').filter({ hasText: 'Apple Account details were encrypted and saved.' })).toBeVisible();
  await expect.poll(() => saveRequests).toBe(1);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
});

test('FairPlay retrieval shows a steady in-progress state without an endless button spinner', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  let credentialStatus = {
    state: 'idle',
  };
  const status = {
    enabled: false,
    ready: false,
    downloaderAvailable: false,
    decryptorAvailable: false,
    fairPlayAuthorized: false,
    vault: { encryptionReady: true, accountConfigured: true, credentialConfigured: false, authenticatedAt: Date.now() },
    blockers: [],
    credentialRetrieval: credentialStatus,
  };
  await page.route('**/v1/dashboard/appstore-offline/status', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...status, credentialRetrieval: credentialStatus }) });
  });
  await page.route('**/v1/dashboard/devices*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ devices: [{ id: 'test-ipad', name: 'Test iPad', enabled: true, transport: 'usb', productType: 'iPad14,3' }] }) });
  });
  let selectedDeviceId = '';
  await page.route('**/v1/dashboard/appstore-offline/credential/retrieve', async (route) => {
    selectedDeviceId = (route.request().postDataJSON() as { deviceId: string }).deviceId;
    credentialStatus = { state: 'running' };
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ...status, credentialRetrieval: credentialStatus }) });
  });

  await page.goto('/?tab=settings&stab=doctor');
  const retrieveButton = page.getByRole('button', { name: 'Retrieve initial key' });
  await expect(retrieveButton).toBeEnabled();
  await retrieveButton.click();

  const inProgressButton = page.getByRole('button', { name: 'Retrieval in progress' });
  await expect(inProgressButton).toBeDisabled();
  await expect(page.getByText('Retrieving from iPad')).toBeVisible();
  await expect(inProgressButton.locator('svg')).toHaveCount(0);
  expect(selectedDeviceId).toBe('test-ipad');
});

test('device managers without automation permission cannot download support bundles', async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(pathname === '/v1/billing' ? { providers: { stripe: { enabled: false }, crypto: { enabled: false } } } : {}),
    });
  });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '128');
  await page.route('**/v1/dashboard/doctor', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, checkedAt: '2026-09-27T12:00:00.000Z', checks: [] }) });
  });

  await page.goto('/?tab=settings&stab=doctor');

  await expect(page.getByRole('heading', { name: 'System doctor' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download support bundle' })).toHaveCount(0);
});

test('authenticated top bar exposes community links without mobile overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAuthenticatedDashboard(page, '1');

  await page.goto('/');
  const github = page.getByRole('link', { name: 'Open dkrypt on GitHub' });
  const discord = page.getByRole('link', { name: 'Join the dkrypt Discord server' });
  await expect(github).toBeVisible();
  await expect(discord).toBeVisible();
  await expect(github).toHaveAttribute('href', 'https://github.com/castdrian/dkrypt');
  await expect(discord).toHaveAttribute('href', 'https://discord.gg/NdaBaxFKnn');
  await expect(discord).toHaveAttribute('target', '_blank');

  const dimensions = await page.evaluate(() => ({ bodyWidth: document.body.scrollWidth, viewportWidth: document.documentElement.clientWidth }));
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  await expectAccessible(page, 'header.glass-topbar');
});

test('authenticated dashboard keeps the build revision out of its header', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');

  await page.goto('/');

  await expect(page.getByText('Build abcdef0', { exact: true })).toHaveCount(0);
});

test('API documentation embeds Scalar in the Docs tab with a new-tab fallback', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  await page.context().route(/\/reference\/?$/, async (route) => {
    await route.fulfill({
      headers: { 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" },
      contentType: 'text/html',
      body: '<!doctype html><html><body><h1>API reference is ready</h1></body></html>',
    });
  });

  await page.goto('/?tab=docs');
  const reference = page.frameLocator('iframe[title="dkrypt API reference"]');
  const referenceLink = page.getByRole('link', { name: 'Open API reference in new tab' });

  await expect(page.locator('iframe[title="dkrypt API reference"]')).toBeVisible();
  await expect(page.locator('iframe[title="dkrypt API reference"]')).toHaveAttribute('src', '/reference/');
  await expect(referenceLink).toHaveAttribute('href', '/reference/');
  await expect(referenceLink).toHaveAttribute('target', '_blank');
  await expect(reference.getByRole('heading', { name: 'API reference is ready' })).toBeVisible();
});

test('interface language localizes the account menu and persists to the account', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '2');
  await page.unroute('**/v1/dashboard/me/prefs');

  const savedPrefs = { theme: 'dark', accent: 'violet', sound: true };
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    if (route.request().method() === 'PUT') {
      Object.assign(savedPrefs, route.request().postDataJSON());
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(savedPrefs),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.locator('#interface-language').selectOption('de');

  await expect(page.getByRole('button', { name: 'Startseite', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kontomenü' })).toBeVisible();
  await expect(page.getByText('Anmeldeverbindungen')).toBeVisible();
  await expect(page.getByText('Eigene Entschlüsselungsaufträge beantragen und verwalten')).toBeVisible();
  await expect(page.getByText('Noch keine Passkeys registriert.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sitzungen verwalten' })).toBeVisible();
  await expect(page.locator('#interface-language option[value="en"]')).toHaveText('Englisch');
  await expect(page.locator('.account-menu')).toHaveAttribute('lang', 'de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(() => savedPrefs.interfaceLanguage).toBe('de');

  await page.reload();
  await page.getByRole('button', { name: 'Kontomenü' }).click();
  await expect(page.getByText('Sitzungen verwalten')).toBeVisible();
});

test('notification preferences load and persist from the account menu', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '2');
  await page.unroute('**/v1/dashboard/me/prefs');

  const savedPrefs = {
    theme: 'dark',
    accent: 'violet',
    sound: true,
    pushOnSuccess: true,
    pushOnFailure: false,
    emailOnSuccess: false,
  };
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    if (route.request().method() === 'PUT') {
      Object.assign(savedPrefs, route.request().postDataJSON());
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(savedPrefs),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  const emailPreference = page.getByRole('checkbox', {
    name: 'Email notifications for successful decrypts',
  });
  await expect(emailPreference).toHaveAttribute('aria-checked', 'false');
  await emailPreference.click();
  await expect(emailPreference).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => savedPrefs.emailOnSuccess).toBe(true);

  const pushFailurePreference = page.getByRole('checkbox', {
    name: 'Push notifications for failed decrypts',
  });
  await expect(pushFailurePreference).toHaveAttribute('aria-checked', 'false');
  await pushFailurePreference.click();
  await expect(pushFailurePreference).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => savedPrefs.pushOnFailure).toBe(true);

  await page.reload();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(emailPreference).toHaveAttribute('aria-checked', 'true');
  await expect(pushFailurePreference).toHaveAttribute('aria-checked', 'true');
});

test('high contrast preference updates the interface and persists to the account', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  await page.unroute('**/v1/dashboard/me/prefs');

  const savedPrefs = { theme: 'dark', accent: 'violet', sound: true, highContrast: false };
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    if (route.request().method() === 'PUT') {
      Object.assign(savedPrefs, route.request().postDataJSON());
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(savedPrefs),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  const highContrastToggle = page.getByRole('button', { name: 'High contrast mode' });
  await expect(highContrastToggle).toHaveAttribute('aria-pressed', 'false');
  await highContrastToggle.click();

  await expect(highContrastToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-high-contrast', 'true');
  await expect.poll(() => savedPrefs.highContrast).toBe(true);

  const measureContrastRatios = () => page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = (hex: string) => {
      const raw = hex.trim().replace('#', '');
      const normalized = raw.length === 3 ? [...raw].map((channel) => channel + channel).join('') : raw;
      const channels = [0, 2, 4].map((index) => parseInt(normalized.slice(index, index + 2), 16) / 255);
      const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    const contrast = (first: string, second: string) => {
      const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    };
    return {
      text: contrast(style.getPropertyValue('--foreground').trim(), style.getPropertyValue('--background').trim()),
      accent: contrast(style.getPropertyValue('--color-accent').trim(), style.getPropertyValue('--background').trim()),
    };
  });
  const darkContrast = await measureContrastRatios();
  expect(darkContrast.text).toBeGreaterThanOrEqual(7);
  expect(darkContrast.accent).toBeGreaterThanOrEqual(7);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Theme: dark (click to cycle)' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightContrast = await measureContrastRatios();
  expect(lightContrast.text).toBeGreaterThanOrEqual(7);
  expect(lightContrast.accent).toBeGreaterThanOrEqual(7);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-high-contrast', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'High contrast mode' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-high-contrast', 'true');
  await expect.poll(() => savedPrefs.highContrast).toBe(false);
});

test('personalization search, artifact column order, and touch targets sync to the account', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  await page.unroute('**/v1/dashboard/me/prefs');

  const savedPrefs: Record<string, unknown> = {
    theme: 'dark',
    accent: 'blue',
    sound: true,
    artifactLibrary: { groupByApp: false, columns: ['app', 'bundleId', 'version', 'source', 'size'] },
    largeTargets: false,
  };
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    if (route.request().method() === 'PUT') Object.assign(savedPrefs, route.request().postDataJSON());
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(savedPrefs) });
  });

  await page.goto('/?tab=settings');
  await page.getByRole('textbox', { name: 'Search settings' }).fill('timezone');
  const personalizationResult = page.getByRole('button', { name: 'Personalization', exact: true });
  await expect(personalizationResult).toBeVisible();
  await personalizationResult.click();

  await page.getByRole('button', { name: 'Move Version column earlier' }).click();
  await expect.poll(() => (savedPrefs.artifactLibrary as { columns: string[] }).columns).toEqual(['app', 'version', 'bundleId', 'source', 'size']);
  await page.getByRole('checkbox', { name: 'Larger touch targets' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-large-targets', 'true');
  await expect.poll(() => savedPrefs.largeTargets).toBe(true);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-large-targets', 'true');
  await expect(page.getByRole('button', { name: 'Move Version column earlier' })).toBeEnabled();
  expect((savedPrefs.artifactLibrary as { columns: string[] }).columns).toEqual(['app', 'version', 'bundleId', 'source', 'size']);
});

test('sidebar collapse and drag width persist while Home layout controls live in Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockAuthenticatedDashboard(page, '1');
  await page.unroute('**/v1/dashboard/me/prefs');
  const savedPrefs: Record<string, unknown> = { theme: 'dark', accent: 'blue', sound: true, sidebarWidth: 256, sidebarCollapsed: false };
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    if (route.request().method() === 'PUT') Object.assign(savedPrefs, route.request().postDataJSON());
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(savedPrefs) });
  });

  await page.goto('/');
  const sidebar = page.locator('aside.app-sidebar');
  await expect(sidebar).toHaveCSS('width', '256px');
  await expect(page.getByRole('heading', { name: 'Home layout' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebar).toHaveCSS('width', '64px');
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  await expect.poll(() => savedPrefs.sidebarCollapsed).toBe(true);

  await page.reload();
  await expect(sidebar).toHaveCSS('width', '64px');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(sidebar).toHaveCSS('width', '256px');
  const resizeHandle = page.getByRole('button', { name: /Resize sidebar/ });
  await resizeHandle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(sidebar).toHaveCSS('width', '272px');
  await expect.poll(() => savedPrefs.sidebarWidth).toBe(272);
  const handleBounds = await resizeHandle.boundingBox();
  if (!handleBounds) throw new Error('sidebar resize handle is not visible');
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x + handleBounds.width / 2 + 32, handleBounds.y + 40);
  await page.mouse.up();
  await expect(sidebar).toHaveCSS('width', '304px');
  await expect.poll(() => savedPrefs.sidebarWidth).toBe(304);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Personal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home layout' })).toBeVisible();
  await page.reload();
  await expect(sidebar).toHaveCSS('width', '304px');
});

test('account menu shows a stable username instead of an OAuth provider ID', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  await page.unroute('**/v1/auth/session');
  let displayName = 'Visual user';
  let username = 'first-name';
  const userId = 'discord:238058491548401664';
  await page.route('**/v1/auth/session', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      loggedIn: true,
      sub: userId,
      username,
      displayName,
      permissions: '1',
      identities: [],
      linkedProviders: [],
      githubOauthEnabled: false,
      discordOauthEnabled: false,
      deployment: { ref: 'abcdef0123456789' },
      mfa: { enabled: false, recoveryCodesRemaining: 0, required: false },
    }) });
  });
  await page.route('**/v1/auth/profile', async (route) => {
    const body = route.request().postDataJSON() as { displayName: string; username: string };
    displayName = body.displayName;
    username = body.username;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ displayName, username, linkedProviders: [] }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.locator('.account-menu');
  await expect(menu).toContainText('Visual user');
  await expect(menu).toContainText('@first-name');
  await expect(menu).not.toContainText(userId);
  await page.getByRole('button', { name: 'Edit profile name' }).click();
  await page.getByRole('textbox', { name: 'Profile name' }).fill('Chosen display name');
  await page.getByRole('textbox', { name: 'Username' }).fill('chosen-name');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(menu).toContainText('Chosen display name');
  await expect(menu).toContainText('@chosen-name');
  await expect(menu).not.toContainText(userId);
});

test('diagnostic reports show a redacted preview and submit only after consent', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '2');
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/v1/dashboard/diagnostic-reports', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reports: [] }) });
      return;
    }
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: 'application/json',
      status: 201,
      body: JSON.stringify({
        id: 'report-1',
        projectId: 'default',
        category: 'bug',
        summary: 'Lookup failed',
        details: 'I saw an error for [redacted] at [redacted]',
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        status: 'received',
      }),
    });
  });
  await page.route('**/v1/dashboard/diagnostic-reports/preview', async (route) => {
    const draft = route.request().postDataJSON() as { projectId: string; category: string; summary: string };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...draft,
        details: 'I saw an error for [redacted] at [redacted]',
        previewToken: 'signed-preview-token',
        expiresAt: Date.now() + 5 * 60 * 1000,
      }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Report an issue' }).click();
  await page.getByPlaceholder('Example: TestFlight lookup stays unavailable').fill('Lookup failed');
  await page.getByPlaceholder('Include the step you tried, what you expected, and any visible error.').fill('I saw an error for person@example.com at https://private.example/path');
  await page.getByRole('button', { name: 'Preview redactions' }).click();

  const preview = page.getByRole('region', { name: 'Redacted report preview' });
  await expect(preview).toContainText('[redacted]');
  await expect(preview).not.toContainText('person@example.com');
  await expect(page.getByRole('button', { name: 'Submit report' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I reviewed this redacted preview and agree to submit it to dkrypt support.' }).check();
  await page.getByRole('button', { name: 'Submit report' }).click();

  await expect.poll(() => submitted?.details).toBe('I saw an error for [redacted] at [redacted]');
  await expect(page.getByText('Your report was submitted.')).toBeVisible();
});

test('system forced-colors mode uses system surface and text colors', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' });
  await page.goto('/?tab=home');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const card = document.querySelector<HTMLElement>('[data-slot="card"]');
    const button = document.querySelector<HTMLElement>('button[data-slot="button"].bg-secondary');
    const systemPalette = document.createElement('div');
    systemPalette.style.backgroundColor = 'Canvas';
    systemPalette.style.color = 'CanvasText';
    systemPalette.style.borderColor = 'ButtonBorder';
    document.body.append(systemPalette);
    const systemColors = getComputedStyle(systemPalette);
    const expectedSurface = systemColors.backgroundColor;
    const expectedBorder = systemColors.borderTopColor;
    systemPalette.style.color = 'CanvasText';
    const expectedText = getComputedStyle(systemPalette).color;
    systemPalette.style.backgroundColor = 'ButtonFace';
    const expectedButtonBackground = getComputedStyle(systemPalette).backgroundColor;
    systemPalette.style.color = 'ButtonText';
    const expectedButtonText = getComputedStyle(systemPalette).color;
    systemPalette.remove();
    return {
      background: style.getPropertyValue('--background').trim(),
      foreground: style.getPropertyValue('--foreground').trim(),
      accent: style.getPropertyValue('--color-accent').trim(),
      accentContrast: style.getPropertyValue('--color-accent-contrast').trim(),
      cardBackground: card ? getComputedStyle(card).backgroundColor : '',
      cardText: card ? getComputedStyle(card).color : '',
      cardBorder: card ? getComputedStyle(card).borderTopColor : '',
      buttonBackground: button ? getComputedStyle(button).backgroundColor : '',
      buttonText: button ? getComputedStyle(button).color : '',
      expectedSurface,
      expectedText,
      expectedButtonBackground,
      expectedButtonText,
      expectedBorder,
    };
  });

  expect(colors).toMatchObject({
    background: 'Canvas',
    foreground: 'CanvasText',
    accent: 'Highlight',
    accentContrast: 'HighlightText',
    cardBackground: colors.expectedSurface,
    cardText: colors.expectedText,
    cardBorder: colors.expectedBorder,
    buttonBackground: colors.expectedButtonBackground,
    buttonText: colors.expectedButtonText,
  });
  await expectAccessible(page);
});

test('reduced-motion preference minimizes animation and smooth scrolling', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/pricing');

  const motionStyles = await page.evaluate(() => {
    const marker = document.createElement('div');
    marker.className = 'skeleton';
    document.body.append(marker);
    const animation = getComputedStyle(marker);
    const result = {
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: animation.animationDuration,
      animationIterationCount: animation.animationIterationCount,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    };
    marker.remove();
    return result;
  });

  expect(motionStyles.reducedMotion).toBe(true);
  expect(motionStyles.animationDuration).toMatch(/^(0|0\.01ms|1e-0?5s)$/);
  expect(motionStyles.animationIterationCount).toBe('1');
  expect(motionStyles.scrollBehavior).toBe('auto');
});

test('populated device management and preflight dialog meet accessibility checks', async ({ page }) => {
  const device = {
    id: 'test-device',
    name: 'Lab iPad',
    transport: 'usb',
    port: 22,
    user: 'mobile',
    udid: '00008110-001234567890001E',
    productType: 'iPad14,1',
    enabled: true,
    isPrimary: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const health = {
    reachable: true,
    screenIsOn: false,
    batteryPercent: 82,
    checkedAt: Date.now(),
    readiness: { score: 100, state: 'ready', reasons: [] },
    subsystems: { usb: 'ready', mux: 'ready', agent: 'ready', appStore: 'idle', testFlight: 'ready', sshTunnel: 'ready' },
  };

  await mockAuthenticatedSession(page, '2097152');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [device],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/events', async (route) => {
    await route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  });
  await page.route('**/v1/dashboard/devices/test-device/health*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(health) });
  });
  const activityEntries = Array.from({ length: 100 }, (_, index) => ({
    id: `activity-${index}`,
    ts: Date.now() - index * 60_000,
    deviceId: device.id,
    kind: 'health',
    message: `Device activity ${String(index).padStart(3, '0')}`,
  }));
  await page.route('**/v1/dashboard/devices/test-device/activity*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ activity: cursor ? activityEntries.slice(50) : activityEntries.slice(0, 50), total: activityEntries.length, nextCursor: cursor ? undefined : 'activity-older' }),
    });
  });
  await page.route('**/v1/dashboard/devices/test-device/preflight', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ device, health, ready: true, checks: [{ label: 'USB transport', ok: true, detail: 'Device agent is reachable.' }] }),
    });
  });

  await page.addInitScript(() => {
    localStorage.setItem('onboardingTourSeen', 'true');
    localStorage.setItem('onboardingDismissed', 'true');
  });
  await page.goto('/?tab=settings&stab=devices');
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByText('Lab iPad', { exact: true })).toBeVisible();
  await expect(page.getByText('online', { exact: true })).toBeVisible();
  await expect(page.getByText('App Store', { exact: true })).toBeVisible();
  await expect(page.getByText('Not open', { exact: true })).toBeVisible();
  const activityList = page.getByRole('list', { name: 'Lab iPad activity' });
  const activityViewport = page.getByRole('region', { name: 'Lab iPad activity scroll area' });
  await expect(activityList.getByRole('listitem').first()).toContainText('Device activity 000');
  await expect.poll(() => activityList.getByRole('listitem').count()).toBeLessThan(40);
  await page.getByRole('button', { name: 'Load older (50)' }).click();
  await expect(activityList.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => activityViewport.evaluate((element) => element.scrollHeight)).toBeGreaterThan(2000);
  await activityViewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(activityList.getByText('Device activity 099')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Preflight' }).click();
  await expect(page.getByText('Device preflight')).toBeVisible();
  await expect(page.getByText('ready for decrypts')).toBeVisible();
  await expectAccessible(page);
});

test('first-time device setup explains USB pairing without asking for manual Wi-Fi connection details', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '128');
  await page.route('**/v1/dashboard/devices/discover', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ devices: [], scannedNetworks: [], warnings: [] }) });
  });

  await page.goto('/?tab=settings&stab=devices');
  await page.getByRole('button', { name: 'Find a device' }).click();

  await expect(page.getByText('Connect the device by USB for first-time setup. Paired Wi-Fi devices are discovered automatically afterward.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Wi-Fi device address')).toHaveCount(0);
  await expect(page.getByLabel('SSH port')).toHaveCount(0);
  await expectAccessible(page);
});

test('IPA Library virtualizes loaded rows and opens artifact provenance in the inspector', async ({ page }) => {
  const sha256 = 'a'.repeat(64);
  const warning = 'Payload/Example.app/Extensions/Share.appex/Share still encrypted (cryptid != 0)';
  const artifacts = Array.from({ length: 100 }, (_, index) => ({
    id: `artifact-${index}`,
    key: `com.example.provenance${index ? `.${index}` : ''}:appstore:${123 + index}`,
    projectIds: ['default'],
    bundleId: `com.example.provenance${index ? `.${index}` : ''}`,
    channel: 'appstore',
    versionLabel: '2.4.0',
    buildNumber: `${240 + index}`,
    fileSizeBytes: 1024 * 1024,
    sha256,
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 3,
    sourceJobId: `job-provenance-${index}`,
    warnings: index === 0 ? [warning] : [],
    fileUrl: `/v1/dashboard/artifacts/artifact-${index}/file`,
  }));

  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    const requestPath = new URL(route.request().url()).pathname;
    const detailId = requestPath.split('/').at(-1);
    if (detailId && detailId !== 'artifacts') {
      const selected = artifacts.find((entry) => entry.id === detailId);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(selected) });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifacts,
        total: artifacts.length,
        totalBytes: artifacts.length * 1024 * 1024,
        maxBytes: 1024 * 1024 * 10,
      }),
    });
  });

  await mockStableDashboardEvents(page);

  const artifactResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/artifacts?') && response.ok());
  await page.goto('/?tab=home&projectId=default&aq=provenance&asource=appstore');
  await artifactResponse;
  const list = page.getByRole('list', { name: 'IPA library artifacts' });
  const viewport = page.getByRole('region', { name: 'IPA library artifacts scroll area' });
  const artifact = list.getByRole('listitem').filter({ hasText: 'com.example.provenance' }).first();
  await expect(artifact).toBeVisible();
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(100);
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  const details = artifact.getByRole('button', { name: 'Artifact details' });
  await expect(details).toBeVisible();
  await expect(page.getByText(sha256, { exact: true })).not.toBeVisible();

  await details.click();
  const inspector = page.getByRole('dialog', { name: 'Artifact details' });
  const inspectorPosition = await inspector.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, viewportWidth: document.documentElement.clientWidth };
  });
  expect(inspectorPosition.left).toBeGreaterThan(0);
  expect(inspectorPosition.right).toBeGreaterThanOrEqual(inspectorPosition.viewportWidth - 20);
  expect(inspectorPosition.right).toBeLessThanOrEqual(inspectorPosition.viewportWidth);
  expect(inspectorPosition.top).toBe(0);
  expect(await details.evaluate((button) => button.parentElement === button.closest('[data-artifact-id]')?.querySelector('a[download]')?.parentElement)).toBe(true);
  await expect.poll(() => new URL(page.url()).searchParams.get('artifact')).toBe('artifact-0');
  const detailUrl = new URL(page.url());
  expect(detailUrl.searchParams.get('projectId')).toBe('default');
  expect(detailUrl.searchParams.get('aq')).toBe('provenance');
  expect(detailUrl.searchParams.get('asource')).toBe('appstore');
  expect(detailUrl.searchParams.get('artifact')).toBe('artifact-0');
  await expect(page.getByRole('heading', { name: 'Artifact metadata' })).toBeVisible();
  await expect(page.getByText(sha256, { exact: true })).toBeVisible();
  await expect(page.getByText('job-provenance-0', { exact: true })).toBeVisible();
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
  const resizeHandle = page.getByRole('button', { name: /Resize Artifact details panel/ });
  await resizeHandle.focus();
  await resizeHandle.press('ArrowLeft');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dkrypt-inspector-width:artifact'))).toBe('0.62');
  await viewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
  await expect(list.locator('[aria-posinset="100"]')).toBeAttached();
  await expect(list.getByText('com.example.provenance.99', { exact: true }).first()).toBeVisible();
  await viewport.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(list.locator('[aria-posinset="1"]')).toBeAttached();
  await expect(page.getByText(sha256, { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Artifact metadata' })).toBeVisible();
  await expect(page.getByText(sha256, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Resize Artifact details panel, 62 percent wide/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: /Resize Artifact details panel/ })).toBeHidden();
  const mobileInspectorPosition = await inspector.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight };
  });
  expect(mobileInspectorPosition.left).toBe(0);
  expect(mobileInspectorPosition.right).toBeGreaterThanOrEqual(mobileInspectorPosition.viewportWidth - 20);
  expect(mobileInspectorPosition.right).toBeLessThanOrEqual(mobileInspectorPosition.viewportWidth);
  expect(mobileInspectorPosition.top).toBeGreaterThan(0);
  expect(mobileInspectorPosition.bottom).toBeCloseTo(mobileInspectorPosition.viewportHeight, 0);
  const restoredUrl = new URL(page.url());
  expect(restoredUrl.searchParams.get('aq')).toBe('provenance');
  expect(restoredUrl.searchParams.get('asource')).toBe('appstore');
});

test('IPA Library bulk pinning sends one bounded update for the selected artifacts', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '8589934593');
  const artifact = {
    id: 'bulk-artifact-a',
    key: 'com.example.bulk:appstore:123',
    projectIds: ['default'],
    bundleId: 'com.example.bulk',
    channel: 'appstore',
    versionLabel: '2.4.0',
    buildNumber: '240',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    fileUrl: '/v1/dashboard/artifacts/bulk-artifact-a/file',
  };
  const bulkRequests: Array<{ ids: string[]; pinned: boolean }> = [];
  let artifactPinnedAt: string | undefined;
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { ids: string[]; pinned: boolean };
      bulkRequests.push(payload);
      artifactPinnedAt = payload.pinned ? '2026-09-26T13:00:00.000Z' : undefined;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          pinned: payload.pinned,
          changedIds: payload.ids,
          artifacts: payload.ids.map((artifactId) => ({ artifactId, pinned: payload.pinned, pinnedAt: artifactPinnedAt })),
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts: [{ ...artifact, pinnedAt: artifactPinnedAt }], total: 1, totalBytes: 1024, maxBytes: 10240 }),
    });
  });

  const artifactResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/artifacts?') && response.ok());
  await page.goto('/?tab=home');
  await artifactResponse;
  await page.getByRole('button', { name: 'Select items' }).click();
  await page.getByRole('checkbox', { name: 'Select com.example.bulk 2.4.0 (240)' }).check();
  await page.getByRole('button', { name: 'Pin selected', exact: true }).click();

  await expect.poll(() => bulkRequests.length).toBe(1);
  expect(bulkRequests[0]).toEqual({ ids: ['bulk-artifact-a'], pinned: true });
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pin selected', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Background tasks' }).click();
  await expect(page.getByRole('dialog')).toContainText('Updated 1 artifacts');
  await page.reload();
  await page.getByRole('button', { name: 'Background tasks' }).click();
  await expect(page.getByRole('dialog')).toContainText('Updated 1 artifacts');
});

test('audit history virtualizes entries without losing older records', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '135168');
  const entries = Array.from({ length: 100 }, (_, index) => ({
    id: `audit-${index}`,
    ts: Date.now() - index * 60_000,
    actor: `manager-${index}`,
    action: 'user.add',
    target: `member-${index}`,
    detail: `Granted access ${String(index).padStart(3, '0')}`,
  }));
  await page.route('**/v1/dashboard/users', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ users: [] }) });
  });
  await page.route('**/v1/dashboard/roles', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ roles: [] }) });
  });
  await page.route('**/v1/dashboard/audit-log*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries, total: entries.length }) });
  });

  await page.goto('/?tab=settings&stab=users');

  const list = page.getByRole('list', { name: 'Audit log entries' });
  const viewport = page.getByRole('region', { name: 'Audit log entries scroll area' });
  await expect(list.getByRole('listitem').first()).toContainText('Granted access 000');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-posinset', '1');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(60);

  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.getByText('member-99', { exact: true })).toBeVisible();
  await expectAccessible(page);
});

test('mobile managers can reach a member role assignment without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '8194');
  let savedRoleIds: string[] | undefined;
  await page.route('**/v1/dashboard/users', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ users: [{ username: 'github:teammate', displayName: 'Teammate', roleIds: [], addedAt: Date.now(), priority: 0 }] }) });
  });
  await page.route('**/v1/dashboard/roles', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ roles: [{ id: 'operator', name: 'Operator', color: '#818cf8', permissions: '2', position: 1, isDefault: false, createdAt: Date.now(), updatedAt: Date.now() }] }) });
  });
  await page.route('**/v1/dashboard/audit-log*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [], total: 0 }) });
  });
  await page.route(/\/v1\/dashboard\/users\/.+/, async (route) => {
    if (route.request().method() === 'PATCH') savedRoleIds = route.request().postDataJSON().roleIds;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/?tab=settings&stab=users');
  await page.getByText('Select for bulk roles').click();
  await expect(page.getByRole('checkbox', { name: 'Select Teammate' })).toBeChecked();
  await page.getByText('Select for bulk roles').click();
  const manage = page.getByRole('button', { name: 'Manage roles', exact: true });
  await expect(manage).toBeVisible();
  const manageBounds = await manage.boundingBox();
  expect(manageBounds).not.toBeNull();
  expect(manageBounds!.x).toBeGreaterThanOrEqual(0);
  expect(manageBounds!.x + manageBounds!.width).toBeLessThanOrEqual(320);
  expect(manageBounds!.height).toBeGreaterThanOrEqual(44);
  await manage.click();
  const role = page.getByRole('checkbox', { name: 'Assign Operator' });
  await expect(role).toBeVisible();
  await page.getByText('Operator', { exact: true }).click();
  await expect(role).toBeChecked();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Save roles' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(role).toBeChecked();
  await page.getByRole('button', { name: 'Save roles' }).click();
  await page.getByRole('button', { name: 'Apply access change' }).click();
  await expect.poll(() => savedRoleIds).toEqual(['operator']);
});

test('ordinary and paid members see device availability in the status pane without health permissions', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await mockAuthenticatedDashboard(page, '2');
  let isPaidPlan = false;
  let detailedHealthRequests = 0;
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      schedulerEnabled: false,
      settings: {},
      watches: [],
      devices: [],
      deviceStatus: { configured: 1, enabled: 1, online: 1, ready: 1, attention: 0, checking: 0, unavailable: 0, freshUntil: Date.now() + 60_000 },
      schedulerRunHistory: [],
      disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
      isPaidPlan,
      maintenance: { active: false, manual: false, auto: false },
      activeJobs: [],
    }) });
  });
  await page.route('**/v1/dashboard/devices/*/health*', async (route) => {
    detailedHealthRequests += 1;
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }) });
  });

  for (const paid of [false, true]) {
    isPaidPlan = paid;
    if (paid) await mockAuthenticatedSession(page, '0');
    await page.goto('/?tab=home');
    await expect(page.getByText('1 device ready', { exact: true }).first()).toBeVisible();
    expect(detailedHealthRequests).toBe(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open status drawer' }).click();
  await expect(page.getByLabel('Status drawer').getByText('1 device ready', { exact: true })).toBeVisible();
  expect(detailedHealthRequests).toBe(0);
});

test('member status warns when a connected device cannot decrypt and expires an old green reading', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.clock.install();
  await mockAuthenticatedDashboard(page, '0');
  let blocked = true;
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      schedulerEnabled: false,
      settings: {},
      watches: [],
      devices: [],
      deviceStatus: { configured: 1, enabled: 1, online: 1, ready: blocked ? 0 : 1, attention: blocked ? 1 : 0, checking: 0, unavailable: 0, freshUntil: Date.now() + 1_000 },
      schedulerRunHistory: [],
      disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
      isPaidPlan: true,
      maintenance: { active: false, manual: false, auto: false },
      activeJobs: [],
    }) });
  });

  await page.goto('/?tab=home');
  await expect(page.getByText('Device needs attention', { exact: true }).first()).toBeVisible();
  blocked = false;
  await page.reload();
  await expect(page.getByText('1 device ready', { exact: true }).first()).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect(page.getByText('Device status outdated', { exact: true }).first()).toBeVisible();
});

test('bulk retry queues only failures, continues after an error, and exports per-job results', async ({ page }) => {
  const entries = [
    {
      id: 'job-done',
      bundleId: 'com.example.done',
      status: 'done',
      source: 'manual',
      createdAt: 1000,
      finishedAt: 2000,
      fileAvailable: true,
    },
    {
      id: 'job-network-failure',
      bundleId: 'com.example.network-failure',
      status: 'failed',
      source: 'manual',
      createdAt: 1000,
      finishedAt: 3000,
      error: 'device transport failed',
      fileAvailable: false,
    },
    {
      id: 'job-queued-success',
      bundleId: 'com.example.queued-success',
      status: 'failed',
      source: 'manual',
      createdAt: 1000,
      finishedAt: 4000,
      error: 'device transport failed',
      fileAvailable: false,
    },
  ];
  const attemptedBundleIds: string[] = [];
  const queuedBundleIds: string[] = [];

  await mockAuthenticatedDashboard(page, '1');
  await mockStableDashboardEvents(page);
  await page.route('**/v1/dashboard/jobs?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ history: entries, total: entries.length }),
    });
  });
  await page.route('**/v1/dashboard/jobs/bulk-preview', async (route) => {
    const body = route.request().postDataJSON() as { ids: string[] };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        requested: body.ids.length,
        eligible: body.ids.length,
        projectedQueueAdds: body.ids.length,
        estimatedDurationMs: 60_000,
        previousSizeBytes: 0,
        items: body.ids.map((id) => ({
          id,
          bundleId: entries.find((entry) => entry.id === id)?.bundleId,
          status: entries.find((entry) => entry.id === id)?.status,
          action: 'queue',
        })),
      }),
    });
  });
  await page.route('**/v1/dashboard/decrypt', async (route) => {
    const body = route.request().postDataJSON() as { bundleId: string };
    attemptedBundleIds.push(body.bundleId);
    if (body.bundleId === 'com.example.network-failure') {
      await route.abort('failed');
      return;
    }
    queuedBundleIds.push(body.bundleId);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'job-retry',
        bundleId: body.bundleId,
        source: 'manual',
        status: 'queued',
        progress: 'Queued',
        createdAt: new Date().toISOString(),
        queue: { position: 1, total: 1 },
      }),
    });
  });

  await page.goto('/');
  await expect(page.getByRole('checkbox', { name: 'Select or unselect all loaded jobs' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select or unselect all loaded jobs' }).click();

  const retryFailedOnly = page.getByRole('button', { name: 'Retry failed only (2)' });
  await expect(retryFailedOnly).toBeVisible();
  const previewRequest = page.waitForRequest((request) => request.url().includes('/v1/dashboard/jobs/bulk-preview'));
  await retryFailedOnly.click();
  expect((await previewRequest).postDataJSON()).toMatchObject({ ids: ['job-network-failure', 'job-queued-success'] });

  await expect(page.getByText('Preview bulk decrypt')).toBeVisible();
  await page.getByRole('button', { name: 'Queue 2', exact: true }).click();
  await expect.poll(() => attemptedBundleIds).toEqual(['com.example.network-failure', 'com.example.queued-success']);
  await expect.poll(() => queuedBundleIds).toEqual(['com.example.queued-success']);

  const retryResults = page.getByRole('region', { name: 'Bulk retry results' });
  await expect(retryResults.getByRole('status')).toContainText('1 queued · 1 failed · 0 already active');
  await expect(retryResults).toContainText('network error');

  const csvDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export retry results CSV' }).click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toBe('dkrypt-bulk-retry-results.csv');
  const csvPath = await csvDownload.path();
  expect(csvPath).toBeTruthy();
  const csvContent = await readFile(csvPath as string, 'utf8');
  expect(csvContent).toContain('com.example.network-failure');
  expect(csvContent).toContain('com.example.queued-success');

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export retry results JSON' }).click();
  const jsonDownload = await jsonDownloadPromise;
  expect(jsonDownload.suggestedFilename()).toBe('dkrypt-bulk-retry-results.json');
  const jsonPath = await jsonDownload.path();
  expect(jsonPath).toBeTruthy();
  expect(JSON.parse(await readFile(jsonPath as string, 'utf8'))).toMatchObject([
    { historyJobId: 'job-network-failure', bundleId: 'com.example.network-failure', outcome: 'failed' },
    { historyJobId: 'job-queued-success', bundleId: 'com.example.queued-success', outcome: 'queued' },
  ]);
});

test('TestFlight shortcuts reappear from the account cache while a reload refresh is pending', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '17179869186');

  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ entries: [{ bundleId: 'com.example.testflight', displayName: 'Example TestFlight App', displayNameLanguage: 'en', metadataFetchedAt: Date.now(), updatedAt: Date.now() }] }),
    });
  });
  let catalogCalls = 0;
  let holdCatalogResponse = false;
  let refreshingEmptyCatalogDelivered = false;
  let releaseReloadResponse!: () => void;
  let reloadRequestStarted!: () => void;
  const reloadResponse = new Promise<void>((resolve) => (releaseReloadResponse = resolve));
  const reloadRequest = new Promise<void>((resolve) => (reloadRequestStarted = resolve));
  await page.route('**/v1/dashboard/testflight/catalog*', async (route) => {
    catalogCalls += 1;
    if (holdCatalogResponse) {
      reloadRequestStarted();
      await reloadResponse;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ apps: [], fetchedAt: Date.now(), refreshing: true }),
      });
      refreshingEmptyCatalogDelivered = true;
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [{
          appId: 123,
          bundleId: 'com.example.testflight',
          displayName: 'Example TestFlight App',
          devices: [{ id: 'ipad-1', name: 'Lab iPad' }],
          lastVerifiedAt: Date.now() - 60 * 60_000,
          deviceSource: true,
        }],
        fetchedAt: Date.now(),
        refreshing: false,
      }),
    });
  });

  await page.goto('/');
  const shortcut = page.getByRole('button', { name: /Example TestFlight App/ });
  await expect(shortcut).toBeVisible();
  await expect(page.getByRole('status', { name: 'TestFlight availability may be out of date' })).toBeVisible();
  holdCatalogResponse = true;
  try {
    await page.reload();
    await reloadRequest;
    await expect(shortcut).toBeVisible();
  } finally {
    releaseReloadResponse();
  }
  await expect.poll(() => refreshingEmptyCatalogDelivered).toBe(true);
  await expect.poll(() => catalogCalls).toBeGreaterThanOrEqual(2);
  await expect(shortcut).toBeVisible();
  await expect(page.getByRole('status', { name: 'Refreshing TestFlight availability' })).toBeVisible();
  const cachedBundleId = await page.evaluate(() => {
    const cached = sessionStorage.getItem('dkrypt:testflight-catalog:v1:member');
    return cached ? (JSON.parse(cached) as { apps?: Array<{ bundleId?: string }> }).apps?.[0]?.bundleId : undefined;
  });
  expect(cachedBundleId).toBe('com.example.testflight');
  await expectAccessible(page);
});

test('TestFlight catalog refresh failures offer a retry instead of an empty-state message', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '17179869186');
  let catalogCalls = 0;
  let retryRequested = false;
  await page.route('**/v1/dashboard/testflight/catalog*', async (route) => {
    catalogCalls += 1;
    if (!retryRequested) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'TestFlight is temporarily unavailable' }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ apps: [], fetchedAt: Date.now(), refreshing: false }),
    });
  });

  await page.goto('/');
  await expect.poll(() => catalogCalls).toBeGreaterThan(0);
  await expect(page.getByText('Couldn’t check TestFlight availability.', { exact: true })).toBeVisible();
  await expect(page.getByText('No TestFlight apps yet.')).toHaveCount(0);
  retryRequested = true;
  await page.getByRole('button', { name: 'Retry TestFlight availability' }).click();
  await expect(page.getByText('No TestFlight apps yet.')).toBeVisible();
  await expect.poll(() => catalogCalls).toBeGreaterThanOrEqual(2);
  await expectAccessible(page);
});

test('operational logs render a small accessible window and older rows remain reachable by scrolling', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2048');
  const logs = Array.from({ length: 100 }, (_, index) => ({
    id: `virtual-log-${index}`,
    ts: Date.now() - index * 1_000,
    level: 'info',
    scope: 'scheduler',
    message: `virtual log entry ${String(index).padStart(3, '0')}`,
    meta: { index },
  }));
  await page.route('**/v1/dashboard/logs*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ logs, total: logs.length }),
    });
  });

  await page.goto('/?tab=logs');

  const list = page.getByRole('list', { name: 'Operational log entries' });
  const viewport = page.getByRole('region', { name: 'Operational log entries scroll area' });
  await expect(list.getByRole('listitem').first()).toContainText('virtual log entry 000');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-posinset', '1');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(60);

  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.getByText('virtual log entry 099')).toBeVisible();
  await expect(list.getByRole('listitem').last()).toHaveAttribute('aria-posinset', '100');
  await expectAccessible(page);
});

test('dashboard notifications virtualize older entries while keeping them scrollable', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2048');
  const notifications = Array.from({ length: 100 }, (_, index) => {
    const createdAt = Date.now() - index * 1_000;
    return {
      id: `virtual-notification-${index}`,
      title: `History notification ${String(index).padStart(3, '0')}`,
      message: 'This notification remains available in the account history.',
      severity: 'info',
      createdAt,
      readAt: Date.now(),
      ...(index === 0 ? {
        occurrenceCount: 3,
        firstOccurredAt: createdAt - 20_000,
        lastOccurredAt: createdAt,
        deviceId: 'device-1',
        href: '/?tab=settings&stab=devices#device-device-1',
      } : {}),
      ...(index === 1 ? {
        deploymentId: 'run-notification-2',
        href: '/?tab=settings&stab=doctor#deployment-run-notification-2',
      } : {}),
    };
  });
  let notificationRequests = 0;
  await page.route('**/v1/dashboard/notifications*', async (route) => {
    notificationRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ notifications, unread: 0, total: notifications.length }),
    });
  });

  await page.goto('/?tab=home');
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect.poll(() => notificationRequests).toBeGreaterThan(0);

  const list = page.getByRole('list', { name: 'Dashboard notifications' });
  const viewport = page.getByRole('region', { name: 'Dashboard notifications scroll area' });
  await expect(list.getByRole('listitem').first()).toContainText('History notification 000');
  await expect(list.getByText(/Occurred 3 times · last/)).toBeVisible();
  await expect(list.getByRole('link', { name: 'Open device' })).toHaveAttribute('href', '/?tab=settings&stab=devices#device-device-1');
  await expect(list.getByRole('link', { name: 'Open deployment' })).toHaveAttribute('href', '/?tab=settings&stab=doctor#deployment-run-notification-2');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-posinset', '1');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(60);

  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.getByText('History notification 099')).toBeVisible();
  await expect(list.getByRole('listitem').last()).toHaveAttribute('aria-posinset', '100');
  await expectAccessible(page);
});

test('device and deployment notification links reach targets rendered after asynchronous loads', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 240 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '128');
  await page.unroute('**/v1/dashboard/overview*');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [
          ...Array.from({ length: 5 }, (_, index) => ({
            id: `device-before-${index}`,
            name: `iPad ${index}`,
            productType: 'iPad13,8',
            transport: 'usb',
            enabled: true,
            isPrimary: false,
            udid: `udid-before-${index}`,
          })),
          { id: 'device-target', name: 'Target iPad', productType: 'iPad13,8', transport: 'usb', enabled: true, isPrimary: true, udid: 'udid-target' },
        ],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/doctor', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        checkedAt: new Date().toISOString(),
        checks: [],
        deployment: { id: 'run-notification-target', ref: 'abcdef0123456789' },
      }),
    });
  });
  const notifications = [
    {
      id: 'device-target-notification',
      title: 'Device unavailable',
      message: 'The target device needs attention.',
      severity: 'error',
      createdAt: Date.now(),
      readAt: Date.now(),
      deviceId: 'device-target',
      href: '/?tab=settings&stab=devices#device-device-target',
    },
    {
      id: 'deployment-target-notification',
      title: 'Deployment ready',
      message: 'A deployment is live.',
      severity: 'success',
      createdAt: Date.now() - 1,
      readAt: Date.now(),
      deploymentId: 'run-notification-target',
      href: '/?tab=settings&stab=doctor#deployment-run-notification-target',
    },
  ];
  await page.route('**/v1/dashboard/notifications*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ notifications, unread: 0, total: notifications.length }) });
  });

  await page.goto('/?tab=home');
  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByRole('link', { name: 'Open device' }).click();
  const deviceTarget = page.locator('#device-device-target');
  await expect(deviceTarget).toBeVisible();
  await expect.poll(() => deviceTarget.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    return top > -30 && top < 100;
  })).toBe(true);

  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByRole('link', { name: 'Open deployment' }).click();
  const deploymentTarget = page.locator('#deployment-run-notification-target');
  await expect(deploymentTarget).toBeVisible();
  await expect.poll(() => deploymentTarget.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    return top > -30 && top < 100;
  })).toBe(true);
});

test('job history stays virtualized as older cursor pages are loaded', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  const finishedAt = Date.now() - 60_000;
  const entries = Array.from({ length: 100 }, (_, index) => ({
    id: `history-${index}`,
    bundleId: `com.example.history.${String(index).padStart(3, '0')}`,
    status: 'done',
    source: 'manual',
    createdAt: finishedAt - 5_000,
    finishedAt,
    fileAvailable: false,
  }));
  await page.route('**/v1/dashboard/jobs?*', async (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    const start = cursor ? Number(cursor.replace('history-', '')) : 0;
    const history = entries.slice(start, start + 15);
    const nextStart = start + history.length;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        history,
        total: entries.length,
        nextCursor: nextStart < entries.length ? `history-${nextStart}` : undefined,
      }),
    });
  });

  await page.goto('/?tab=home');

  const list = page.getByRole('list', { name: 'Job history entries' });
  const viewport = page.getByRole('region', { name: 'Job history entries scroll area' });
  await expect(list.getByText('com.example.history.000')).toBeVisible();
  await expect(viewport).toHaveAttribute('tabindex', '0');
  const firstRow = list.getByRole('listitem').first();
  await expect(firstRow).toHaveAttribute('aria-setsize', '15');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(20);

  let expectedSize = 15;
  while (expectedSize < entries.length) {
    const nextSize = Math.min(expectedSize + 15, entries.length);
    await page.getByRole('button', { name: /Load more/ }).click();
    await expect(firstRow).toHaveAttribute('aria-setsize', String(nextSize));
    expectedSize = nextSize;
  }

  await expect(list.getByText('com.example.history.099')).toHaveCount(0);
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight)).toBeGreaterThan(5000);
  await viewport.focus();
  await page.keyboard.press('End');
  await expect(list.getByText('com.example.history.099')).toBeVisible();
  await expect(list.getByRole('listitem').last()).toHaveAttribute('aria-posinset', '100');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(35);
  await expectAccessible(page);
});

test('job details show the persisted queue blocker alongside retry guidance', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  const queueReason = 'No enabled device is eligible for this scheduled job.';
  await page.route('**/v1/dashboard/jobs/queue-timeout/timeline', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'queue-timeout',
        correlationId: 'queue-timeout',
        bundleId: 'com.example.queued',
        status: 'failed',
        queueReason,
        events: [{ at: Date.now() - 30_000, label: 'Failed: job deadline exceeded while waiting in the queue', status: 'failed' }],
        guidance: {
          category: 'Queue wait expired',
          title: 'Queue wait expired',
          action: 'Resolve the queue blocker shown in the job timeline or device status, then retry.',
          retryRecommended: true,
        },
      }),
    });
  });

  await page.goto('/?tab=home&job=queue-timeout');

  await expect(page.getByText(queueReason, { exact: true })).toBeVisible();
  await expect(page.getByText('Resolve the queue blocker shown in the job timeline or device status, then retry.', { exact: true })).toBeVisible();
});

test('active jobs show per-job queue estimates and the latest queue completion estimate', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '2');
  await page.unroute('**/v1/dashboard/overview*');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [
          {
            id: 'queue-estimate-first',
            bundleId: 'com.example.queue.first',
            source: 'manual',
            status: 'queued',
            progress: 'queued',
            createdAt: Date.now(),
            priority: 0,
            queue: { position: 2, total: 2, predictedStartMs: 45_000, predictedCompletionMs: 120_000 },
          },
          {
            id: 'queue-estimate-last',
            bundleId: 'com.example.queue.last',
            source: 'scheduler',
            status: 'queued',
            progress: 'queued',
            createdAt: Date.now(),
            priority: 0,
            queue: { position: 3, total: 3, predictedStartMs: 120_000, predictedCompletionMs: 300_000 },
          },
        ],
      }),
    });
  });

  await page.goto('/?tab=home');

  await expect(page.getByText('Est. start in <1m', { exact: true })).toBeVisible();
  await expect(page.getByText('Est. completion in ~2m', { exact: true })).toBeVisible();
  await expect(page.getByText('Queue clears in ~5m', { exact: true })).toBeVisible();
});

test('release comparisons show build numbers, release notes, metadata freshness, and cache reuse', async ({ page }) => {
  const bundleId = 'com.example.release-comparison';
  const finishedAt = Date.now() - 60_000;
  const entries = [
    {
      id: 'comparison-appstore',
      bundleId,
      versionLabel: '1.0',
      status: 'done',
      source: 'manual',
      createdAt: finishedAt - 5_000,
      finishedAt,
      fileAvailable: false,
      cacheHit: true,
      ipaMetadata: { shortVersion: '1.0', bundleVersion: '100' },
    },
    {
      id: 'comparison-testflight',
      bundleId,
      versionLabel: '1.1',
      status: 'done',
      source: 'manual',
      createdAt: finishedAt,
      finishedAt: finishedAt + 1,
      fileAvailable: false,
      testflight: {
        appId: 123,
        build: {
          id: 456,
          bundleId,
          cfBundleShortVersion: '1.1',
          cfBundleVersion: '101',
          whatsNew: 'TestFlight build notes',
        },
      },
    },
  ];

  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  await page.route('**/v1/dashboard/jobs?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ history: entries, total: entries.length }),
    });
  });
  await page.route('**/v1/dashboard/jobs/stats/*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        bundleId,
        totalRuns: 2,
        doneCount: 2,
        failedCount: 0,
        successRate: 1,
        avgDurationMs: 1_000,
        lastRunAt: finishedAt,
        failureBreakdown: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/jobs/diff*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        a: { id: entries[0].id, versionLabel: '1.0', buildNumber: '100', channel: 'appstore', cacheHit: true, finishedAt },
        b: { id: entries[1].id, versionLabel: '1.1', buildNumber: '101', releaseNotes: 'TestFlight build notes', channel: 'testflight', finishedAt: finishedAt + 1 },
        sizeDeltaBytes: 0,
        plistDiff: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/apps/metadata*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [{
          bundleId,
          displayName: 'Release comparison app',
          displayNameLanguage: 'en',
          releaseNotes: 'Latest App Store notes',
          metadataFetchedAt: Date.now(),
          updatedAt: Date.now(),
        }],
      }),
    });
  });

  await page.goto('/?tab=home');
  const jobHistory = page.getByRole('heading', { name: 'Job history' });
  await jobHistory.scrollIntoViewIfNeeded();
  const statsButton = page.getByRole('button', { name: 'Release comparison app', exact: true }).first();
  await expect(statsButton).toBeVisible();
  await statsButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Versions - pick 2 to compare');
  const appStoreBuild = dialog.getByRole('checkbox', { name: 'Select 1.0, build 100' });
  const testFlightBuild = dialog.getByRole('checkbox', { name: 'Select 1.1, build 101' });
  await appStoreBuild.click();
  await testFlightBuild.click();
  await dialog.getByRole('button', { name: 'Compare' }).click();
  await expect(dialog).toContainText('build 100');
  await expect(dialog).toContainText('build 101');
  await expect(dialog).toContainText('reused existing IPA');
  await expect(dialog).toContainText('TestFlight build notes');
  await expect(dialog).toContainText('App Store metadata');
  await expect(dialog).toContainText('Latest App Store notes');
  await expectAccessible(page, '[role="dialog"]');
});
