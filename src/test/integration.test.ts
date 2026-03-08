/**
 * Integration / harness tests
 *
 * These tests wire together real ZerlyKeyManager + ProviderKeyManager + AIService
 * instances (with a mocked RequestRouter) to verify the end-to-end flows that
 * prevent stale results after a browser connect or key rotation:
 *
 *  1. connect → first request uses the new key
 *  2. rotate key mid-flight → old response discarded
 *  3. configVersion bump mid-flight → response discarded
 *  4. deactivate / reactivate → no duplicate URI handler registrations
 *  5. 401 response → reconnect prompt shown
 */

import { ZerlyKeyManager } from '../zerlyKeyManager';
import { ProviderKeyManager } from '../providerKeyManager';
import { AIService } from '../aiService';
import { RequestRouter } from '../requestRouter';

// ── Shared helpers ──────────────────────────────────────────────────────────

function makeContext(secretKey = '') {
  const store: Record<string, string> = secretKey ? { zerlyApiKey: secretKey } : {};
  return {
    secrets: {
      get: jest.fn(async (k: string) => store[k] ?? undefined),
      store: jest.fn(async (k: string, v: string) => { store[k] = v; }),
      delete: jest.fn(async (k: string) => { delete store[k]; }),
      _raw: store,
    },
    globalState: { get: jest.fn(), update: jest.fn(async () => {}) },
    workspaceState: { get: jest.fn(), update: jest.fn(async () => {}) },
    subscriptions: { push: jest.fn() },
    extensionUri: { fsPath: '/fake' },
  } as any;
}

function makeProviderContext() {
  const secretsStore: Record<string, string> = {};
  const globalStore: Record<string, unknown> = {};
  return {
    secrets: {
      get: jest.fn(async (k: string) => secretsStore[k] ?? undefined),
      store: jest.fn(async (k: string, v: string) => { secretsStore[k] = v; }),
      delete: jest.fn(async (k: string) => { delete secretsStore[k]; }),
    },
    globalState: {
      get: jest.fn((k: string) => globalStore[k]),
      update: jest.fn(async (k: string, v: unknown) => { globalStore[k] = v; }),
    },
  } as any;
}

async function bootManagers(secretKey = '') {
  ZerlyKeyManager._resetForTests();
  ProviderKeyManager._resetForTests();

  const ctx = makeContext(secretKey);
  const km = ZerlyKeyManager.getInstance(ctx);
  await km.initialize();

  const pm = ProviderKeyManager.getInstance(makeProviderContext());
  await pm.initialize();

  return { km, pm };
}

/**
 * Creates an AIService with a mocked RequestRouter.
 * executeFn can be overridden per test to control responses.
 */
function makeAiService(
  km: ZerlyKeyManager,
  pm: ProviderKeyManager,
  executeFn?: (opts: any) => Promise<any>
) {
  const svc = new AIService();
  svc.setKeyManager(km);
  svc.setProviderManager(pm);

  const router = new RequestRouter();
  const defaultExecute = async (_opts: any) => ({
    content: 'ok',
    status: 200,
    routeUsed: 'zerly',
    modelUsed: 'zerly/zerlino-32b',
    requestId: _opts.requestId,
  });
  (router as any).execute = executeFn ?? defaultExecute;
  svc.setRequestRouter(router);

  return { svc, router };
}

// ─────────────────────────────────────────────────────────────────────────────
afterEach(() => {
  ZerlyKeyManager._resetForTests();
  ProviderKeyManager._resetForTests();
  jest.clearAllMocks();
});

// ── 1. connect → first request uses the new key ─────────────────────────────

describe('Integration: connect → first request uses new key', () => {
  test('request uses the key set by setKey() immediately', async () => {
    const { km, pm } = await bootManagers(''); // start with no key
    await km.setKey('sk_zerly_connected1234');

    let capturedKey = '';
    const { svc } = makeAiService(km, pm, async (opts: any) => {
      capturedKey = km.getCachedKey();
      return { content: 'hello', status: 200, routeUsed: 'zerly', modelUsed: 'm', requestId: opts.requestId };
    });

    await svc.explainCode('const x = 1;', 'test.ts');
    expect(capturedKey).toBe('sk_zerly_connected1234');
  });

  test('no request is forwarded before a key is set', async () => {
    const { km, pm } = await bootManagers(''); // no key
    let executeCalled = false;
    const { svc } = makeAiService(km, pm, async (_opts: any) => {
      executeCalled = true;
      return { content: 'unreachable', status: 200, routeUsed: 'zerly', modelUsed: 'm', requestId: '' };
    });

    const result = await svc.explainCode('const x = 1;', 'test.ts');
    expect(result).toContain('Connect your Zerly account');
    expect(executeCalled).toBe(false);
  });
});

// ── 2. rotate key mid-flight → old response discarded ───────────────────────

describe('Integration: key rotation mid-flight discards old response', () => {
  test('response received after key rotation is suppressed', async () => {
    const { km, pm } = await bootManagers('sk_zerly_initialkey1');

    const { svc } = makeAiService(km, pm, async (opts: any) => {
      // Rotate the key while the "network call" is in progress
      await km.setKey('sk_zerly_rotatedkey12');
      return { content: 'stale content', status: 200, routeUsed: 'zerly', modelUsed: 'm', requestId: opts.requestId };
    });

    const result = await svc.explainCode('const x = 1;', 'test.ts');
    expect(result).toContain('configuration change');
    expect(result).not.toContain('stale content');
  });

  test('keyVersion increments on rotation; subsequent request succeeds', async () => {
    const { km, pm } = await bootManagers('sk_zerly_initialkey1');
    const versionBefore = km.keyVersion;

    await km.setKey('sk_zerly_rotatedkey12');
    expect(km.keyVersion).toBe(versionBefore + 1);

    const { svc } = makeAiService(km, pm, async (opts: any) => ({
      content: 'fresh result', status: 200, routeUsed: 'zerly', modelUsed: 'm', requestId: opts.requestId,
    }));

    const result = await svc.explainCode('code', 'main.ts');
    expect(result).toBe('fresh result');
  });
});

// ── 3. configVersion bump mid-flight → response discarded ────────────────────

describe('Integration: provider config change mid-flight discards response', () => {
  test('response after configVersion bump is suppressed', async () => {
    const { km, pm } = await bootManagers('sk_zerly_configtest12');

    const { svc } = makeAiService(km, pm, async (opts: any) => {
      await pm.setConfig({ routeMode: 'provider_override' });
      return { content: 'stale cfg', status: 200, routeUsed: 'zerly', modelUsed: 'm', requestId: opts.requestId };
    });

    const result = await svc.explainCode('code', 'test.ts');
    expect(result).toContain('configuration change');
    expect(result).not.toContain('stale cfg');
  });
});

// ── 4. deactivate / reactivate → no duplicate event subscriptions ───────────

describe('Integration: deactivate / reactivate produces a single key-change handler', () => {
  test('only one onKeyChanged listener fires after dispose + re-init', async () => {
    ZerlyKeyManager._resetForTests();
    ProviderKeyManager._resetForTests();

    const ctx = makeContext('sk_zerly_existingkey1');
    const km1 = ZerlyKeyManager.getInstance(ctx);
    await km1.initialize();

    const fires1: (string | null)[] = [];
    km1.onKeyChanged.event(k => fires1.push(k));

    await km1.setKey('sk_zerly_rotated1234');
    expect(fires1.length).toBe(1);

    km1.dispose();

    const ctx2 = makeContext('sk_zerly_rotated1234');
    const km2 = ZerlyKeyManager.getInstance(ctx2);
    await km2.initialize();

    const fires2: (string | null)[] = [];
    km2.onKeyChanged.event(k => fires2.push(k));

    await km2.setKey('sk_zerly_finalkey345');
    expect(fires2.length).toBe(1);
    expect(fires1.length).toBe(1); // unchanged — old handler is gone
  });
});

// ── 5. 401 response → reconnect prompt shown ─────────────────────────────────

describe('Integration: 401 response triggers reconnect prompt', () => {
  test('401 from router returns reconnect message', async () => {
    const { km, pm } = await bootManagers('sk_zerly_expiredkey1');

    const { svc } = makeAiService(km, pm, async (opts: any) => ({
      content: '', status: 401, routeUsed: 'zerly', modelUsed: 'm', requestId: opts.requestId,
    }));

    const { window } = require('vscode');
    const result = await svc.explainCode('code', 'file.ts');

    expect(result).toContain('Invalid or unauthorized');
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('API key rejected'),
      'Connect Zerly'
    );
  });

  test('in-flight count returns to <= 1 after a request completes (even on error)', async () => {
    const { km, pm } = await bootManagers('sk_zerly_expiredkey1');
    const { svc } = makeAiService(km, pm, async (opts: any) => ({
      content: '', status: 401, routeUsed: 'zerly', modelUsed: 'm', requestId: opts.requestId,
    }));

    expect(svc.getInflightCount()).toBe(0);
    await svc.explainCode('code', 'file.ts');
    expect(svc.getInflightCount()).toBeLessThanOrEqual(1);
  });

  test('clearKey after 401 resets key presence', async () => {
    ZerlyKeyManager._resetForTests();
    ProviderKeyManager._resetForTests();

    const ctx = makeContext('sk_zerly_expiredkey1');
    const km = ZerlyKeyManager.getInstance(ctx);
    await km.initialize();

    await km.clearKey();
    expect(km.hasKey()).toBe(false);
    expect(km.getCachedKey()).toBe('');
  });
});

