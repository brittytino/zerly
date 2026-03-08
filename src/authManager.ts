// src/authManager.ts
// Handles GitHub OAuth login flow inside VS Code.
// The extension registers a URI handler for vscode://zerlyai.zerly/auth
// so the backend can deep-link the JWT back after the browser OAuth dance.
//
// The handler also handles the Zerly API key connect flow:
//   vscode://<publisher>.<name>/auth?key=sk_zerly_...
// which saves the key via ZerlyKeyManager (SecretStorage).

import * as vscode from 'vscode';
import axios from 'axios';
import { ZerlyKeyManager, zerlyLog } from './zerlyKeyManager';

const BACKEND_URL =
  vscode.workspace.getConfiguration("zerly").get<string>("apiUrl") ??
  "https://zerly.tinobritty.me";

const TOKEN_KEY = "zerly.authToken";
const PLAN_KEY = "zerly.plan";

export type Plan = "FREE" | "PRO" | "TEAM" | "ENTERPRISE";

export interface ZerlyUser {
  id: string;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  plan: Plan;
}

// ── AuthManager ───────────────────────────────────────────────────────────────

export class AuthManager implements vscode.UriHandler {
  private static instance: AuthManager;
  private context: vscode.ExtensionContext;
  private _keyManager: ZerlyKeyManager | null = null;
  private _lastAuthUriTs: number | null = null;

  private constructor(ctx: vscode.ExtensionContext) {
    this.context = ctx;
  }

  /** Timestamp (ms) of the most recent deep-link URI received. For diagnostics. */
  getLastAuthUriTimestamp(): number | null {
    return this._lastAuthUriTs;
  }

  /** Wire up the ZerlyKeyManager so API key deep-links are handled correctly. */
  setKeyManager(km: ZerlyKeyManager): void {
    this._keyManager = km;
  }

  static getInstance(ctx?: vscode.ExtensionContext): AuthManager {
    if (!AuthManager.instance) {
      if (!ctx) throw new Error("AuthManager not initialized");
      AuthManager.instance = new AuthManager(ctx);
    }
    return AuthManager.instance;
  }

  // ── URI handler — VS Code calls this when the deep-link arrives ─────────────
  //
  // Supported URL patterns (both handled under the same VS Code URI handler):
  //
  //  1) Zerly API key connect flow:
  //     vscode://<publisher>.<name>/auth?key=sk_zerly_...
  //
  //  2) Legacy GitHub OAuth callback:
  //     vscode://<publisher>.<name>/auth?token=<jwt>&plan=<plan>
  //
  async handleUri(uri: vscode.Uri): Promise<void> {
    this._lastAuthUriTs = Date.now();
    const keyVersion = this._keyManager?.keyVersion ?? 0;
    zerlyLog('auth-uri-received', `Path: ${uri.path} Query: ${uri.query}`, {
      meta: { keyVersion },
    });

    if (!uri.path.startsWith('/auth')) return;

    const params = new URLSearchParams(uri.query);

    // ── Zerly API key connect flow ─────────────────────────────────────────────
    const apiKey = params.get('key');
    if (apiKey) {
      if (!this._keyManager) {
        vscode.window.showErrorMessage('Zerly: Key manager not initialized. Please restart VS Code.');
        return;
      }
      const result = await this._keyManager.setKey(apiKey);
      if (!result.ok) {
        vscode.window.showErrorMessage(`Zerly: Invalid API key received. ${result.error}`);
        zerlyLog('key-save-failed', result.error ?? 'unknown');
        return;
      }
      const source = params.get('source') ?? '';
      const mode = params.get('mode') ?? '';
      const setupProviders = params.get('setupProviders') === '1';

      zerlyLog('key-saved', 'API key received and saved via deep-link', {
        meta: { keyVersion: this._keyManager.keyVersion, source, mode, setupProviders },
      });
      vscode.window.showInformationMessage('Zerly: Account connected! AI features are now active. 🟣');
      // ZerlyKeyManager.onKeyChanged fires automatically — caches cleared, webview refreshed.
      if (setupProviders) {
        // Delay slightly so the welcome message renders first.
        setTimeout(() => vscode.commands.executeCommand('zerly.setupProviders'), 500);
      }
      return;
    }

    // ── Legacy GitHub OAuth token flow ─────────────────────────────────────────
    const token = params.get('token');
    const plan = (params.get('plan') ?? 'FREE') as Plan;

    if (!token) {
      vscode.window.showErrorMessage('Zerly: Authentication failed — no token received.');
      return;
    }

    await this.context.secrets.store(TOKEN_KEY, token);
    await this.context.globalState.update(PLAN_KEY, plan);

    zerlyLog('key-saved', 'GitHub OAuth token saved');
    vscode.window.showInformationMessage(`Zerly: Signed in successfully! Plan: ${plan}`);
    vscode.commands.executeCommand('zerly.refresh');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Open GitHub login in the system browser */
  async login(): Promise<void> {
    const loginUrl = vscode.Uri.parse(`${BACKEND_URL}/auth/github`);
    await vscode.env.openExternal(loginUrl);
  }

  /** Remove stored credentials */
  async logout(): Promise<void> {
    await this.context.secrets.delete(TOKEN_KEY);
    await this.context.globalState.update(PLAN_KEY, undefined);
    vscode.commands.executeCommand("zerly.refresh");
    vscode.window.showInformationMessage("Zerly: Signed out.");
  }

  /** Returns the stored JWT or undefined */
  async getToken(): Promise<string | undefined> {
    return this.context.secrets.get(TOKEN_KEY);
  }

  /** Returns the locally cached plan — fast, no network call */
  getCachedPlan(): Plan {
    return (this.context.globalState.get<Plan>(PLAN_KEY)) ?? "FREE";
  }

  /** Fetches current user profile + plan from the backend */
  async getMe(): Promise<ZerlyUser | null> {
    const token = await this.getToken();
    if (!token) return null;

    try {
      const res = await axios.get<{ user: ZerlyUser & { subscription: { plan: Plan } } }>(
        `${BACKEND_URL}/auth/me`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const plan = res.data.user.subscription?.plan ?? "FREE";
      await this.context.globalState.update(PLAN_KEY, plan);

      return { ...res.data.user, plan };
    } catch {
      return null;
    }
  }

  /** Re-issue a fresh JWT with the latest plan embedded */
  async refreshToken(): Promise<string | null> {
    const token = await this.getToken();
    if (!token) return null;

    try {
      const res = await axios.post<{ token: string; plan: Plan }>(
        `${BACKEND_URL}/auth/refresh`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );

      await this.context.secrets.store(TOKEN_KEY, res.data.token);
      await this.context.globalState.update(PLAN_KEY, res.data.plan);

      return res.data.token;
    } catch {
      return null;
    }
  }

  async isLoggedIn(): Promise<boolean> {
    const t = await this.context.secrets.get(TOKEN_KEY);
    return !!t;
  }
}
