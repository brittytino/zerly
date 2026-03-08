/**
 * Unit tests: ProviderKeyManager
 *
 * Coverage:
 *  1. Default config is correct on first initialize
 *  2. setKey validates length, stores to SecretStorage, bumps configVersion
 *  3. removeKey clears storage and bumps configVersion
 *  4. setConfig persists to globalState and fires onConfigChanged
 *  5. initialize loads persisted keys + merged config from storage
 *  6. maskedKey never exposes full key
 *  7. hasKey reflects cached state
 *  8. Singleton reset between tests (no cross-contamination)
 */

import { ProviderKeyManager, DEFAULT_MODELS } from '../providerKeyManager';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeContext(
  initialSecrets: Record<string, string> = {},
  initialGlobal: Record<string, unknown> = {}
) {
  const secretsStore: Record<string, string> = { ...initialSecrets };
  const globalStore: Record<string, unknown> = { ...initialGlobal };

  return {
    secrets: {
      get: jest.fn(async (key: string) => secretsStore[key] ?? undefined),
      store: jest.fn(async (key: string, val: string) => { secretsStore[key] = val; }),
      delete: jest.fn(async (key: string) => { delete secretsStore[key]; }),
      _store: secretsStore,
    },
    globalState: {
      get: jest.fn((key: string) => globalStore[key]),
      update: jest.fn(async (key: string, val: unknown) => { globalStore[key] = val; }),
      _store: globalStore,
    },
  } as any;
}

afterEach(() => {
  ProviderKeyManager._resetForTests();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('ProviderKeyManager — initialization', () => {
  test('singleton: second call without ctx returns same instance', async () => {
    const ctx = makeContext();
    const a = ProviderKeyManager.getInstance(ctx);
    await a.initialize();
    const b = ProviderKeyManager.getInstance(); // no ctx
    expect(a).toBe(b);
  });

  test('default config after fresh initialize', async () => {
    const ctx = makeContext();
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    const cfg = pm.getConfig();
    expect(cfg.routeMode).toBe('zerly_default');
    expect(cfg.activeProvider).toBe('openai');
    expect(cfg.models).toEqual(DEFAULT_MODELS);
    expect(pm.configVersion).toBe(0);
  });

  test('loads persisted keys from SecretStorage on initialize', async () => {
    const ctx = makeContext({ zerlyProviderOpenAI: 'sk-openai-key123456' });
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    expect(pm.hasKey('openai')).toBe(true);
    expect(pm.getCachedKey('openai')).toBe('sk-openai-key123456');
    expect(pm.hasKey('anthropic')).toBe(false);
    expect(pm.hasKey('gemini')).toBe(false);
  });

  test('merges stored config with defaults on initialize', async () => {
    const storedConfig = {
      routeMode: 'auto_fallback',
      activeProvider: 'anthropic',
      models: { openai: 'gpt-4o', anthropic: 'claude-3-haiku-20240307', gemini: 'gemini-1.5-flash' },
    };
    const ctx = makeContext({}, { zerlyProviderConfig: storedConfig });
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    const cfg = pm.getConfig();
    expect(cfg.routeMode).toBe('auto_fallback');
    expect(cfg.activeProvider).toBe('anthropic');
    expect(cfg.models.openai).toBe('gpt-4o');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('ProviderKeyManager — setKey', () => {
  test('rejects keys shorter than 8 characters', async () => {
    const ctx = makeContext();
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    const result = await pm.setKey('openai', 'short');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(pm.hasKey('openai')).toBe(false);
    expect(pm.configVersion).toBe(0);
  });

  test('stores key and bumps configVersion on success', async () => {
    const ctx = makeContext();
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    const result = await pm.setKey('openai', 'sk-openai-valid-key-123');
    expect(result.ok).toBe(true);
    expect(pm.hasKey('openai')).toBe(true);
    expect(pm.configVersion).toBe(1);
    expect(ctx.secrets._store.zerlyProviderOpenAI).toBe('sk-openai-valid-key-123');
  });

  test('fires onConfigChanged after setKey', async () => {
    const ctx = makeContext();
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    const fired: any[] = [];
    pm.onConfigChanged.event(cfg => fired.push(cfg));

    await pm.setKey('anthropic', 'sk-ant-validkey123456');
    expect(fired).toHaveLength(1);
    expect(fired[0].routeMode).toBe('zerly_default'); // config unchanged
  });

  test('trims whitespace from key before storing', async () => {
    const ctx = makeContext();
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    await pm.setKey('gemini', '  AIzaValidKeyXXXXXXXX  ');
    expect(pm.getCachedKey('gemini')).toBe('AIzaValidKeyXXXXXXXX');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('ProviderKeyManager — removeKey', () => {
  test('removes key and bumps configVersion', async () => {
    const ctx = makeContext({ zerlyProviderOpenAI: 'sk-openai-key123456' });
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    expect(pm.hasKey('openai')).toBe(true);
    await pm.removeKey('openai');
    expect(pm.hasKey('openai')).toBe(false);
    expect(pm.configVersion).toBe(1);
    expect(ctx.secrets._store.zerlyProviderOpenAI).toBeUndefined();
  });

  test('fires onConfigChanged after removeKey', async () => {
    const ctx = makeContext({ zerlyProviderGemini: 'AIzaKeyXXXXXXXX1234' });
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    const calls: any[] = [];
    pm.onConfigChanged.event(cfg => calls.push(cfg));
    await pm.removeKey('gemini');
    expect(calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('ProviderKeyManager — setConfig', () => {
  test('updates routeMode and persists to globalState', async () => {
    const ctx = makeContext();
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    await pm.setConfig({ routeMode: 'provider_override', activeProvider: 'gemini' });
    const cfg = pm.getConfig();
    expect(cfg.routeMode).toBe('provider_override');
    expect(cfg.activeProvider).toBe('gemini');
    expect(pm.configVersion).toBe(1);

    const persisted = ctx.globalState._store.zerlyProviderConfig as any;
    expect(persisted.routeMode).toBe('provider_override');
  });

  test('partial update preserves existing fields', async () => {
    const ctx = makeContext();
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    await pm.setConfig({ routeMode: 'auto_fallback' });
    const cfg = pm.getConfig();
    expect(cfg.activeProvider).toBe('openai'); // unchanged
    expect(cfg.models).toEqual(DEFAULT_MODELS); // unchanged
  });

  test('fires onConfigChanged after setConfig', async () => {
    const ctx = makeContext();
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    const calls: any[] = [];
    pm.onConfigChanged.event(c => calls.push(c));
    await pm.setConfig({ routeMode: 'auto_fallback' });
    expect(calls).toHaveLength(1);
    expect(calls[0].routeMode).toBe('auto_fallback');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('ProviderKeyManager — maskedKey', () => {
  test('returns (none) when no key set', async () => {
    const ctx = makeContext();
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();
    expect(pm.maskedKey('openai')).toBe('(none)');
  });

  test('never exposes full key in masked output', async () => {
    const ctx = makeContext({ zerlyProviderOpenAI: 'sk-openai-supersecretkey123' });
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    const masked = pm.maskedKey('openai');
    expect(masked).not.toBe('sk-openai-supersecretkey123');
    expect(masked).toContain('****');
    expect(masked).not.toContain('supersecretkey');
  });

  test('short key (8-12 chars) — only shows first 4 chars', async () => {
    const ctx = makeContext({ zerlyProviderOpenAI: 'sk-short1' }); // 9 chars
    const pm = ProviderKeyManager.getInstance(ctx);
    await pm.initialize();

    const masked = pm.maskedKey('openai');
    expect(masked.startsWith('sk-s')).toBe(true);
    expect(masked).toContain('****');
  });
});
