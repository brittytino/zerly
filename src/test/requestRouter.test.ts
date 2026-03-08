/**
 * Unit tests: RequestRouter
 *
 * Coverage:
 *  1. zerly_default mode calls Zerly endpoint with Bearer key
 *  2. provider_override (openai) calls correct endpoint
 *  3. provider_override (anthropic) uses x-api-key + anthropic-version header, reads content[0].text
 *  4. auto_fallback: uses provider first, falls back to Zerly on 401/403/429
 *  5. auto_fallback: falls back to Zerly on network error from provider
 *  6. routeUsed and modelUsed are set correctly in all modes
 *  7. requestId is forwarded via X-Request-Id header
 */

import { RequestRouter, RouterCallOptions } from '../requestRouter';
import { ZerlyKeyManager } from '../zerlyKeyManager';
import { ProviderKeyManager } from '../providerKeyManager';

// ── Fetch mock setup ──────────────────────────────────────────────────────────

// Store captured fetch calls for assertion
const capturedCalls: { url: string; init: RequestInit }[] = [];

function makeFetchResponse(body: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeOpenAiResponse(content: string, status = 200) {
  return makeFetchResponse(
    { choices: [{ message: { content } }] },
    status
  );
}

function makeAnthropicResponse(text: string, status = 200) {
  return makeFetchResponse(
    { content: [{ type: 'text', text }] },
    status
  );
}

// ── Context helpers ───────────────────────────────────────────────────────────

function makeContext(
  secrets: Record<string, string> = {},
  global: Record<string, unknown> = {}
) {
  const secretsStore: Record<string, string> = { ...secrets };
  const globalStore: Record<string, unknown> = { ...global };
  return {
    secrets: {
      get: jest.fn(async (key: string) => secretsStore[key] ?? undefined),
      store: jest.fn(async (key: string, val: string) => { secretsStore[key] = val; }),
      delete: jest.fn(async (key: string) => { delete secretsStore[key]; }),
    },
    globalState: {
      get: jest.fn((key: string) => globalStore[key]),
      update: jest.fn(async (key: string, val: unknown) => { globalStore[key] = val; }),
    },
  } as any;
}

const SAMPLE_MESSAGES: RouterCallOptions['messages'] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello' },
];

const BASE_OPTS: RouterCallOptions = {
  messages: SAMPLE_MESSAGES,
  maxTokens: 256,
  requestId: 'test-req-id-001',
};

// ── Singleton teardown ────────────────────────────────────────────────────────

afterEach(() => {
  ZerlyKeyManager._resetForTests();
  ProviderKeyManager._resetForTests();
  jest.clearAllMocks();
  capturedCalls.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('RequestRouter — zerly_default mode', () => {
  test('calls Zerly endpoint with Bearer auth and returns content', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeOpenAiResponse('Hello from Zerly'));
    global.fetch = fetchMock;

    // Set up ZerlyKeyManager with a cached key
    const zerlyCtx = makeContext({ zerlyApiKey: 'sk_zerly_test_key_12345' });
    const km = ZerlyKeyManager.getInstance(zerlyCtx);
    await km.initialize();

    const providerCtx = makeContext();
    const pm = ProviderKeyManager.getInstance(providerCtx);
    await pm.initialize();
    // Default config = zerly_default

    const router = new RequestRouter();
    router.setKeyManager(km);
    router.setProviderManager(pm);

    const result = await router.execute(BASE_OPTS);

    expect(result.content).toBe('Hello from Zerly');
    expect(result.routeUsed).toBe('zerly');
    expect(result.modelUsed).toBe('zerly/zerlino-32b');
    expect(result.status).toBe(200);
    expect(result.requestId).toBe('test-req-id-001');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('zerly.tinobritty.me');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk_zerly_test_key_12345');
    expect(headers['X-Request-Id']).toBe('test-req-id-001');
    expect(headers['Cache-Control']).toBe('no-store');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('RequestRouter — provider_override mode (OpenAI)', () => {
  test('calls OpenAI endpoint with provider key', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeOpenAiResponse('OpenAI response'));
    global.fetch = fetchMock;

    const zerlyCtx = makeContext({ zerlyApiKey: 'sk_zerly_key_12345678' });
    const km = ZerlyKeyManager.getInstance(zerlyCtx);
    await km.initialize();

    const providerCtx = makeContext({ zerlyProviderOpenAI: 'sk-openai-testkey12345' });
    const pm = ProviderKeyManager.getInstance(providerCtx);
    await pm.initialize();
    await pm.setConfig({ routeMode: 'provider_override', activeProvider: 'openai' });

    const router = new RequestRouter();
    router.setKeyManager(km);
    router.setProviderManager(pm);

    const result = await router.execute(BASE_OPTS);

    expect(result.content).toBe('OpenAI response');
    expect(result.routeUsed).toBe('openai');
    expect(result.modelUsed).toBe('gpt-4o-mini');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.openai.com');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-openai-testkey12345');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('RequestRouter — provider_override mode (Anthropic)', () => {
  test('uses x-api-key header and anthropic-version, reads content[0].text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeAnthropicResponse('Haiku says hi'));
    global.fetch = fetchMock;

    const km = ZerlyKeyManager.getInstance(makeContext());
    await km.initialize();

    const providerCtx = makeContext({ zerlyProviderAnthropic: 'sk-ant-testkey123456' });
    const pm = ProviderKeyManager.getInstance(providerCtx);
    await pm.initialize();
    await pm.setConfig({ routeMode: 'provider_override', activeProvider: 'anthropic' });

    const router = new RequestRouter();
    router.setKeyManager(km);
    router.setProviderManager(pm);

    const result = await router.execute(BASE_OPTS);

    expect(result.content).toBe('Haiku says hi');
    expect(result.routeUsed).toBe('anthropic');
    expect(result.modelUsed).toBe('claude-3-haiku-20240307');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('anthropic.com');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-testkey123456');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Authorization']).toBeUndefined();
  });

  test('separates system message from conversation for Anthropic', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeAnthropicResponse('ok'));
    global.fetch = fetchMock;

    const km = ZerlyKeyManager.getInstance(makeContext());
    await km.initialize();
    const providerCtx = makeContext({ zerlyProviderAnthropic: 'sk-ant-validkey123456' });
    const pm = ProviderKeyManager.getInstance(providerCtx);
    await pm.initialize();
    await pm.setConfig({ routeMode: 'provider_override', activeProvider: 'anthropic' });

    const router = new RequestRouter();
    router.setKeyManager(km);
    router.setProviderManager(pm);

    await router.execute(BASE_OPTS);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('You are a helpful assistant.');
    // system message excluded from messages array
    expect(body.messages.every((m: any) => m.role !== 'system')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('RequestRouter — auto_fallback mode', () => {
  test('uses Zerly when provider returns 401', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeFetchResponse({ choices: [] }, 401))  // provider → 401
      .mockResolvedValueOnce(makeOpenAiResponse('Zerly fallback'));      // Zerly → ok

    global.fetch = fetchMock;

    const zerlyCtx = makeContext({ zerlyApiKey: 'sk_zerly_key_12345678' });
    const km = ZerlyKeyManager.getInstance(zerlyCtx);
    await km.initialize();

    const providerCtx = makeContext({ zerlyProviderOpenAI: 'sk-openai-badkey123456' });
    const pm = ProviderKeyManager.getInstance(providerCtx);
    await pm.initialize();
    await pm.setConfig({ routeMode: 'auto_fallback', activeProvider: 'openai' });

    const router = new RequestRouter();
    router.setKeyManager(km);
    router.setProviderManager(pm);

    const result = await router.execute(BASE_OPTS);

    expect(result.content).toBe('Zerly fallback');
    expect(result.routeUsed).toBe('zerly');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('uses Zerly when provider returns 429', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeFetchResponse({}, 429))
      .mockResolvedValueOnce(makeOpenAiResponse('Rate limit fallback'));
    global.fetch = fetchMock;

    const zerlyCtx = makeContext({ zerlyApiKey: 'sk_zerly_key_12345678' });
    const km = ZerlyKeyManager.getInstance(zerlyCtx);
    await km.initialize();

    const providerCtx = makeContext({ zerlyProviderGemini: 'AIza-gemini-testkey123' });
    const pm = ProviderKeyManager.getInstance(providerCtx);
    await pm.initialize();
    await pm.setConfig({ routeMode: 'auto_fallback', activeProvider: 'gemini' });

    const router = new RequestRouter();
    router.setKeyManager(km);
    router.setProviderManager(pm);

    const result = await router.execute(BASE_OPTS);
    expect(result.routeUsed).toBe('zerly');
  });

  test('falls back to Zerly on network error from provider', async () => {
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(makeOpenAiResponse('Network fallback'));
    global.fetch = fetchMock;

    const zerlyCtx = makeContext({ zerlyApiKey: 'sk_zerly_key_12345678' });
    const km = ZerlyKeyManager.getInstance(zerlyCtx);
    await km.initialize();

    const providerCtx = makeContext({ zerlyProviderOpenAI: 'sk-openai-testkey12345' });
    const pm = ProviderKeyManager.getInstance(providerCtx);
    await pm.initialize();
    await pm.setConfig({ routeMode: 'auto_fallback', activeProvider: 'openai' });

    const router = new RequestRouter();
    router.setKeyManager(km);
    router.setProviderManager(pm);

    const result = await router.execute(BASE_OPTS);
    expect(result.routeUsed).toBe('zerly');
    expect(result.content).toBe('Network fallback');
  });

  test('uses provider directly on successful response', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeOpenAiResponse('Direct provider success'));
    global.fetch = fetchMock;

    const zerlyCtx = makeContext({ zerlyApiKey: 'sk_zerly_key_12345678' });
    const km = ZerlyKeyManager.getInstance(zerlyCtx);
    await km.initialize();

    const providerCtx = makeContext({ zerlyProviderOpenAI: 'sk-openai-testkey12345' });
    const pm = ProviderKeyManager.getInstance(providerCtx);
    await pm.initialize();
    await pm.setConfig({ routeMode: 'auto_fallback', activeProvider: 'openai' });

    const router = new RequestRouter();
    router.setKeyManager(km);
    router.setProviderManager(pm);

    const result = await router.execute(BASE_OPTS);
    expect(result.routeUsed).toBe('openai');
    expect(fetchMock).toHaveBeenCalledTimes(1); // provider only, no fallback
  });
});
