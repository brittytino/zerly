// src/authManager.ts
// Handles GitHub OAuth login flow inside VS Code.
// The extension registers a URI handler for vscode://zerlyai.zerly/auth
// so the backend can deep-link the JWT back after the browser OAuth dance.

import * as vscode from "vscode";
import axios from "axios";

const BACKEND_URL =
  vscode.workspace.getConfiguration("zerly").get<string>("apiUrl") ??
  "http://localhost:3000";

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

  private constructor(ctx: vscode.ExtensionContext) {
    this.context = ctx;
  }

  static getInstance(ctx?: vscode.ExtensionContext): AuthManager {
    if (!AuthManager.instance) {
      if (!ctx) throw new Error("AuthManager not initialized");
      AuthManager.instance = new AuthManager(ctx);
    }
    return AuthManager.instance;
  }

  // ── URI handler — VS Code calls this when the deep-link arrives ─────────────
  // URL pattern: vscode://zerlyai.zerly/auth?token=...&plan=...
  async handleUri(uri: vscode.Uri): Promise<void> {
    if (!uri.path.startsWith("/auth")) return;

    const params = new URLSearchParams(uri.query);
    const token = params.get("token");
    const plan = (params.get("plan") ?? "FREE") as Plan;

    if (!token) {
      vscode.window.showErrorMessage("Zerly: Authentication failed — no token received.");
      return;
    }

    await this.context.secrets.store(TOKEN_KEY, token);
    await this.context.globalState.update(PLAN_KEY, plan);

    vscode.window.showInformationMessage(
      `Zerly: Signed in successfully! Plan: ${plan}`
    );

    // Trigger a UI refresh
    vscode.commands.executeCommand("zerly.refresh");
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

  isLoggedIn(): Promise<boolean> {
    return this.context.secrets.get(TOKEN_KEY).then((t) => !!t);
  }
}
