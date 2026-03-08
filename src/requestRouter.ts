/**
 * requestRouter.ts
 *
 * Centralises all outbound AI API calls and implements the three route modes:
 *
 *   zerly_default    — POST to the Zerly backend using the user's Zerly key.
 *   provider_override — POST to the selected 3rd-party provider (OpenAI / Anthropic / Gemini).
 *   auto_fallback    — Try the selected provider; on auth / quota / network failure
 *                      automatically fall back to Zerly.
 *
 * Per-request metadata is attached to every call:
 *   - requestId (UUID-v4)
 *   - Cache-Control: no-store, Pragma: no-cache, X-Request-Id
 *   - routeUsed / modelUsed in result
 */

import { ZerlyKeyManager, zerlyLog } from './zerlyKeyManager';
import { ProviderKeyManager, Provider, RouteMode } from './providerKeyManager';

// ─── Constants ────────────────────────────────────────────────────────────────

const ZERLY_ENDPOINT = 'https://zerly.tinobritty.me/api/v1/chat/completions';
const ZERLY_DEFAULT_MODEL = 'zerly/zerlino-32b';

const PROVIDER_ENDPOINTS: Record<Provider, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  // Gemini exposes an OpenAI-compatible endpoint
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface RouterCallOptions {
  messages: RouterMessage[];
  maxTokens?: number;
  requestId: string;
  signal?: AbortSignal | null;
}

export interface RouterCallResult {
  content: string;
  status: number;
  routeUsed: 'zerly' | Provider;
  modelUsed: string;
  requestId: string;
}

// ─── RequestRouter ────────────────────────────────────────────────────────────

export class RequestRouter {
  private _keyManager: ZerlyKeyManager | null = null;
  private _providerManager: ProviderKeyManager | null = null;

  setKeyManager(km: ZerlyKeyManager): void { this._keyManager = km; }
  setProviderManager(pm: ProviderKeyManager): void { this._providerManager = pm; }

  /**
   * Execute one round-trip.  The caller (AIService) manages retries and abort
   * controllers; this method makes exactly 1–2 HTTP calls (2 only in auto_fallback).
   */
  async execute(opts: RouterCallOptions): Promise<RouterCallResult> {
    const config = this._providerManager?.getConfig();
    const routeMode: RouteMode = config?.routeMode ?? 'zerly_default';

    if (routeMode === 'zerly_default') {
      return this._callZerly(opts);
    }

    const provider = config?.activeProvider ?? 'openai';

    if (routeMode === 'provider_override') {
      return this._callProvider(provider, opts);
    }

    // ── auto_fallback ──────────────────────────────────────────────────────
    try {
      const result = await this._callProvider(provider, opts);
      if (result.status === 401 || result.status === 403 || result.status === 429) {
        zerlyLog('router-fallback',
          `Provider ${provider} returned ${result.status} — falling back to Zerly`,
          { requestId: opts.requestId });
        return this._callZerly(opts);
      }
      return result;
    } catch (err: any) {
      zerlyLog('router-fallback',
        `Provider ${provider} network error — falling back to Zerly`,
        { requestId: opts.requestId, meta: { error: err?.message } });
      return this._callZerly(opts);
    }
  }

  // ── Internal callers ──────────────────────────────────────────────────────

  private async _callZerly(opts: RouterCallOptions): Promise<RouterCallResult> {
    const apiKey = this._keyManager?.getCachedKey() ?? '';
    const model = ZERLY_DEFAULT_MODEL;

    const response = await fetch(ZERLY_ENDPOINT, {
      method: 'POST',
      headers: this._openAiHeaders(apiKey, opts.requestId),
      body: JSON.stringify({
        model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: 0.3,
      }),
      signal: opts.signal ?? undefined,
    });

    const content = await this._readOpenAiContent(response);
    return {
      content,
      status: response.status,
      routeUsed: 'zerly',
      modelUsed: model,
      requestId: opts.requestId,
    };
  }

  private async _callProvider(provider: Provider, opts: RouterCallOptions): Promise<RouterCallResult> {
    const apiKey = this._providerManager?.getCachedKey(provider) ?? '';
    const model = this._providerManager?.getConfig().models[provider] ?? 'gpt-4o-mini';

    if (provider === 'anthropic') {
      return this._callAnthropic(apiKey, model, opts);
    }

    // OpenAI and Gemini both use the OpenAI chat-completions format
    const endpoint = PROVIDER_ENDPOINTS[provider];
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this._openAiHeaders(apiKey, opts.requestId),
      body: JSON.stringify({
        model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: 0.3,
      }),
      signal: opts.signal ?? undefined,
    });

    const content = await this._readOpenAiContent(response);
    return {
      content,
      status: response.status,
      routeUsed: provider,
      modelUsed: model,
      requestId: opts.requestId,
    };
  }

  private async _callAnthropic(
    apiKey: string,
    model: string,
    opts: RouterCallOptions
  ): Promise<RouterCallResult> {
    // Anthropic uses a different auth header, request body, and response schema.
    const systemContent = opts.messages.find(m => m.role === 'system')?.content ?? '';
    const nonSystem = opts.messages.filter(m => m.role !== 'system');

    const response = await fetch(PROVIDER_ENDPOINTS.anthropic, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
        'X-Request-Id': opts.requestId,
      },
      body: JSON.stringify({
        model,
        system: systemContent,
        messages: nonSystem,
        max_tokens: opts.maxTokens ?? 2048,
      }),
      signal: opts.signal ?? undefined,
    });

    if (!response.ok) {
      return { content: '', status: response.status, routeUsed: 'anthropic', modelUsed: model, requestId: opts.requestId };
    }

    const data = (await response.json()) as any;
    const content: string = data.content?.[0]?.text ?? '';
    return { content, status: response.status, routeUsed: 'anthropic', modelUsed: model, requestId: opts.requestId };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _openAiHeaders(apiKey: string, requestId: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'X-Title': 'Zerly AI',
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      'X-Request-Id': requestId,
    };
  }

  private async _readOpenAiContent(response: Response): Promise<string> {
    if (!response.ok) return '';
    const data = (await response.json()) as any;
    return data.choices?.[0]?.message?.content ?? '';
  }
}
