/**
 * providerKeyManager.ts
 *
 * BYOK (Bring Your Own Key) provider management.
 * Stores OpenAI / Anthropic / Gemini API keys in VS Code SecretStorage and
 * maintains route-mode configuration in globalState.
 *
 * Route modes:
 *   zerly_default    — always call the Zerly backend (default)
 *   provider_override — always call the selected 3rd-party provider
 *   auto_fallback    — try 3rd-party provider first; fall back to Zerly on
 *                      auth / quota / network failure
 */

import * as vscode from 'vscode';
import { zerlyLog } from './zerlyKeyManager';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Provider = 'openai' | 'anthropic' | 'gemini';
export type RouteMode = 'zerly_default' | 'provider_override' | 'auto_fallback';

export interface ProviderConfig {
  routeMode: RouteMode;
  /** Which provider is active when mode is provider_override or auto_fallback. */
  activeProvider: Provider;
  /** Model name per provider. */
  models: Record<Provider, string>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SECRET_KEYS: Record<Provider, string> = {
  openai: 'zerlyProviderOpenAI',
  anthropic: 'zerlyProviderAnthropic',
  gemini: 'zerlyProviderGemini',
};

const CONFIG_STATE_KEY = 'zerlyProviderConfig';

export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
  gemini: 'gemini-1.5-flash',
};

const DEFAULT_CONFIG: ProviderConfig = {
  routeMode: 'zerly_default',
  activeProvider: 'openai',
  models: { ...DEFAULT_MODELS },
};

// ─── ProviderKeyManager ───────────────────────────────────────────────────────

export class ProviderKeyManager {
  private static _instance: ProviderKeyManager | undefined;
  private _context: vscode.ExtensionContext;
  private _cachedKeys: Record<Provider, string> = { openai: '', anthropic: '', gemini: '' };
  private _config: ProviderConfig = { ...DEFAULT_CONFIG, models: { ...DEFAULT_MODELS } };
  private _configVersion = 0;

  /** Fired whenever a provider key or routing config changes. */
  readonly onConfigChanged = new vscode.EventEmitter<ProviderConfig>();

  private constructor(ctx: vscode.ExtensionContext) {
    this._context = ctx;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  static getInstance(ctx?: vscode.ExtensionContext): ProviderKeyManager {
    if (!ProviderKeyManager._instance) {
      if (!ctx) throw new Error('ProviderKeyManager: must pass context on first call');
      ProviderKeyManager._instance = new ProviderKeyManager(ctx);
    }
    return ProviderKeyManager._instance;
  }

  /** For tests only — resets the singleton. */
  static _resetForTests(): void {
    ProviderKeyManager._instance = undefined;
  }

  /** Load keys + config from storage. Must be called once in activate(). */
  async initialize(): Promise<void> {
    for (const provider of ['openai', 'anthropic', 'gemini'] as Provider[]) {
      this._cachedKeys[provider] = (await this._context.secrets.get(SECRET_KEYS[provider])) ?? '';
    }

    const stored = this._context.globalState.get<ProviderConfig>(CONFIG_STATE_KEY);
    if (stored) {
      this._config = {
        ...DEFAULT_CONFIG,
        ...stored,
        models: { ...DEFAULT_MODELS, ...stored.models },
      };
    }

    zerlyLog('provider-init', [
      `openai=${!!this._cachedKeys.openai}`,
      `anthropic=${!!this._cachedKeys.anthropic}`,
      `gemini=${!!this._cachedKeys.gemini}`,
      `routeMode=${this._config.routeMode}`,
    ].join(' '));
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get configVersion(): number { return this._configVersion; }

  getConfig(): ProviderConfig {
    return { ...this._config, models: { ...this._config.models } };
  }

  getCachedKey(provider: Provider): string { return this._cachedKeys[provider]; }

  async getKey(provider: Provider): Promise<string> {
    const key = (await this._context.secrets.get(SECRET_KEYS[provider])) ?? '';
    this._cachedKeys[provider] = key;
    return key;
  }

  hasKey(provider: Provider): boolean { return this._cachedKeys[provider].length > 0; }

  /** Safe display string — never exposes the raw key. */
  maskedKey(provider: Provider): string {
    const k = this._cachedKeys[provider];
    if (!k) return '(none)';
    if (k.length <= 12) return k.slice(0, 4) + '****';
    return k.slice(0, 8) + '****' + k.slice(-4);
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  async setKey(provider: Provider, key: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = key.trim();
    if (trimmed.length < 8) {
      return { ok: false, error: 'API key is too short (minimum 8 characters).' };
    }
    this._cachedKeys[provider] = trimmed;
    await this._context.secrets.store(SECRET_KEYS[provider], trimmed);
    this._configVersion++;
    zerlyLog('provider-key-saved', `${provider} key saved`, {
      meta: { provider, configVersion: this._configVersion },
    });
    this.onConfigChanged.fire(this.getConfig());
    return { ok: true };
  }

  async removeKey(provider: Provider): Promise<void> {
    this._cachedKeys[provider] = '';
    await this._context.secrets.delete(SECRET_KEYS[provider]);
    this._configVersion++;
    zerlyLog('provider-key-removed', `${provider} key removed`, {
      meta: { provider, configVersion: this._configVersion },
    });
    this.onConfigChanged.fire(this.getConfig());
  }

  async setConfig(update: Partial<ProviderConfig>): Promise<void> {
    this._config = {
      ...this._config,
      ...update,
      models: { ...this._config.models, ...(update.models ?? {}) },
    };
    this._configVersion++;
    await this._context.globalState.update(CONFIG_STATE_KEY, this._config);
    zerlyLog('provider-config-changed',
      `routeMode=${this._config.routeMode} activeProvider=${this._config.activeProvider}`,
      { meta: { configVersion: this._configVersion } });
    this.onConfigChanged.fire(this.getConfig());
  }

  dispose(): void {
    this.onConfigChanged.dispose();
    ProviderKeyManager._instance = undefined;
  }
}
