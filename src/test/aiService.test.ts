/**
 * Unit tests: AIService
 *
 * Tests:
 *  1. getApiKey() returns keyManager key
 *  2. invalidateAll() aborts all tracked AbortControllers
 *  3. setKeyManager() wires onKeyChanged → invalidateAll
 *  4. setProviderManager() wires onConfigChanged → invalidateAll
 *  5. Stale response suppression via keyVersion mismatch
 *  6. Stale response suppression via configVersion mismatch
 */

import { AIService } from '../aiService';
import { ZerlyKeyManager } from '../zerlyKeyManager';
import { ProviderKeyManager } from '../providerKeyManager';
import { RequestRouter } from '../requestRouter';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContext(secretKey = '') {
  const secretsStore: Record<string, string> = secretKey ? { zerlyApiKey: secretKey } : {};
  return {
    secrets: {
      get: jest.fn(async (k: string) => secretsStore[k] ?? undefined),
      store: jest.fn(async (k: string, v: string) => { secretsStore[k] = v; }),
      delete: jest.fn(async (k: string) => { delete secretsStore[k]; }),
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

async function makeKeyManager(secretKey = '') {
  ZerlyKeyManager._resetForTests();
  const ctx = makeContext(secretKey);
  const km = ZerlyKeyManager.getInstance(ctx);
  await km.initialize();
  return km;
}

async function makeProviderManager() {
  ProviderKeyManager._resetForTests();
  const pm = ProviderKeyManager.getInstance(makeProviderContext());
  await pm.initialize();
  return pm;
}

/** Makes a RequestRouter whose execute() resolves with given result after optional side-effect. */
function makeRouter(
  executeFn: (opts: any) => Promise<any> = async () => ({
    content: 'mock response',
    status: 200,
    routeUsed: 'zerly',
    modelUsed: 'zerly/zerlino-32b',
    requestId: 'mock-req',
  })
): RequestRouter {
  const router = new RequestRouter();
  (router as any).execute = executeFn;
  return router;
}

// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  ZerlyKeyManager._resetForTests();
  ProviderKeyManager._resetForTests();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AIService.getApiKey()', () => {
  test('returns empty string when keyManager has no key', async () => {
    const svc = new AIService();
    const km = await makeKeyManager(''); // no key stored
    svc.setKeyManager(km);
    expect(svc.getApiKey()).toBe('');
  });

  test('returns the key from keyManager', async () => {
    const km = await makeKeyManager('sk_zerly_priority12');
    const svc = new AIService();
    svc.setKeyManager(km);
    expect(svc.getApiKey()).toBe('sk_zerly_priority12');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AIService.invalidateAll()', () => {
  test('aborts all tracked controllers', async () => {
    const svc = new AIService();
    const km = await makeKeyManager('sk_zerly_invalidate12');
    svc.setKeyManager(km);

    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    (svc as any)._taskControllers.set('task_a', ctrl1);
    (svc as any)._taskControllers.set('task_b', ctrl2);

    svc.invalidateAll();

    expect(ctrl1.signal.aborted).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
    expect((svc as any)._taskControllers.size).toBe(0);
  });

  test('works with empty controller map', async () => {
    const svc = new AIService();
    const km = await makeKeyManager('sk_zerly_empty12345');
    svc.setKeyManager(km);
    expect(() => svc.invalidateAll()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AIService.setKeyManager() wires key change → invalidateAll', () => {
  test('invalidateAll called when key changes via setKey()', async () => {
    const km = await makeKeyManager('sk_zerly_existing12');
    const svc = new AIService();
    svc.setKeyManager(km);

    const ctrl = new AbortController();
    (svc as any)._taskControllers.set('some_task', ctrl);

    await km.setKey('sk_zerly_newkey5678');
    expect(ctrl.signal.aborted).toBe(true);
    expect((svc as any)._taskControllers.size).toBe(0);
  });

  test('invalidateAll called when key is cleared', async () => {
    const km = await makeKeyManager('sk_zerly_existing12');
    const svc = new AIService();
    svc.setKeyManager(km);

    const ctrl = new AbortController();
    (svc as any)._taskControllers.set('task_x', ctrl);

    await km.clearKey();
    expect(ctrl.signal.aborted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AIService.setProviderManager() wires config change → invalidateAll', () => {
  test('invalidateAll called when provider config changes', async () => {
    const km = await makeKeyManager('sk_zerly_test123456');
    const pm = await makeProviderManager();
    const svc = new AIService();
    svc.setKeyManager(km);
    svc.setProviderManager(pm);

    const ctrl = new AbortController();
    (svc as any)._taskControllers.set('running_task', ctrl);

    await pm.setConfig({ routeMode: 'provider_override' });
    expect(ctrl.signal.aborted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AIService stale response suppression — keyVersion', () => {
  test('discards response when keyVersion changes mid-request', async () => {
    const km = await makeKeyManager('sk_zerly_staletest12');
    const pm = await makeProviderManager();
    const svc = new AIService();
    svc.setKeyManager(km);
    svc.setProviderManager(pm);

    // Router that rotates the key DURING execution to simulate key change mid-flight
    const router = makeRouter(async () => {
      await km.setKey('sk_zerly_rotatedkey99');
      return { content: 'should-be-suppressed', status: 200, routeUsed: 'zerly', modelUsed: 'm', requestId: 'r' };
    });
    svc.setRequestRouter(router);

    const result = await svc.explainCode('someCode', 'test.ts');
    expect(result).toContain('configuration change');
    expect(result).not.toContain('should-be-suppressed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AIService stale response suppression — configVersion', () => {
  test('discards response when providerConfig changes mid-request', async () => {
    const km = await makeKeyManager('sk_zerly_configtest12');
    const pm = await makeProviderManager();
    const svc = new AIService();
    svc.setKeyManager(km);
    svc.setProviderManager(pm);

    // Router that changes provider config DURING execution
    const router = makeRouter(async () => {
      await pm.setConfig({ routeMode: 'provider_override' });
      return { content: 'stale', status: 200, routeUsed: 'zerly', modelUsed: 'm', requestId: 'r' };
    });
    svc.setRequestRouter(router);

    const result = await svc.explainCode('code', 'test.ts');
    expect(result).toContain('configuration change');
    expect(result).not.toContain('stale');
  });
});

