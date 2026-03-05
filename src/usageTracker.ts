// src/usageTracker.ts
// Client-side usage gating for the VS Code extension.
// Every scan / explanation / chat call goes through trackAndGate() first.
// If the server is unreachable, local counters in globalState act as fallback.

import * as vscode from "vscode";
import axios, { AxiosInstance } from "axios";
import { AuthManager } from "./authManager";
import { SubscriptionManager } from "./subscriptionManager";

type MetricType = "SCAN" | "EXPLANATION" | "CHAT_QUERY";

interface TrackResult {
  allowed: boolean;
  count: number;
  limit: number | null;
  plan: string;
}

// Local fallback limits (mirrors the server FREE tier)
const LOCAL_LIMITS: Record<MetricType, { key: string; limit: number; windowHours: number }> = {
  SCAN: { key: "zerly.usage.scans", limit: 30, windowHours: 720 },         // 30 days
  EXPLANATION: { key: "zerly.usage.explanations", limit: 10, windowHours: 24 },
  CHAT_QUERY: { key: "zerly.usage.chatQueries", limit: 20, windowHours: 24 },
};

interface LocalCounter {
  count: number;
  windowStart: number; // epoch ms
}

const BACKEND_URL =
  vscode.workspace.getConfiguration("zerly").get<string>("apiUrl") ??
  "http://localhost:3000";

export class UsageTracker {
  private static instance: UsageTracker;
  private http: AxiosInstance;
  private auth: AuthManager;
  private sub: SubscriptionManager;
  private ctx: vscode.ExtensionContext;

  private constructor(
    ctx: vscode.ExtensionContext,
    auth: AuthManager,
    sub: SubscriptionManager
  ) {
    this.ctx = ctx;
    this.auth = auth;
    this.sub = sub;

    this.http = axios.create({ baseURL: BACKEND_URL, timeout: 4000 });
    this.http.interceptors.request.use(async (cfg) => {
      const token = await this.auth.getToken();
      if (token) cfg.headers.Authorization = `Bearer ${token}`;
      return cfg;
    });
  }

  static getInstance(
    ctx?: vscode.ExtensionContext,
    auth?: AuthManager,
    sub?: SubscriptionManager
  ): UsageTracker {
    if (!UsageTracker.instance) {
      if (!ctx || !auth || !sub) throw new Error("UsageTracker not initialized");
      UsageTracker.instance = new UsageTracker(ctx, auth, sub);
    }
    return UsageTracker.instance;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Gate + track a usage event.
   * Shows a friendly upgrade prompt when the limit is hit.
   * Returns true if the action is allowed to proceed.
   */
  async trackAndGate(metric: MetricType): Promise<boolean> {
    const loggedIn = await this.auth.isLoggedIn();

    if (loggedIn) {
      return this.trackRemote(metric);
    } else {
      return this.trackLocal(metric);
    }
  }

  /**
   * Returns a snapshot of the user's current usage.
   * Tries the server first; falls back to local counters.
   */
  async getUsageSummary(): Promise<UsageSummary> {
    const loggedIn = await this.auth.isLoggedIn();
    if (!loggedIn) return this.getLocalSummary();

    try {
      const res = await this.http.get<{ usage: UsageSummary }>("/usage/current");
      return res.data.usage;
    } catch {
      return this.getLocalSummary();
    }
  }

  // ── Remote tracking (authenticated users) ────────────────────────────────────

  private async trackRemote(metric: MetricType): Promise<boolean> {
    try {
      const res = await this.http.post<TrackResult>("/usage/track", { metric });
      return res.data.allowed;
    } catch (err: any) {
      // 429 = limit exceeded
      if (err.response?.status === 429) {
        const data: TrackResult = err.response.data?.error;
        await this.showLimitReachedMessage(metric, data?.limit ?? null);
        return false;
      }
      // Network error — fall through to local
      return this.trackLocal(metric);
    }
  }

  // ── Local tracking (offline / unauthenticated) ────────────────────────────────

  private async trackLocal(metric: MetricType): Promise<boolean> {
    const plan = this.sub.getCurrentPlan ? await this.sub.getCurrentPlan() : "FREE";

    // Paid plans bypass local limits
    if (plan !== "FREE") return true;

    const cfg = LOCAL_LIMITS[metric];
    const now = Date.now();
    const windowMs = cfg.windowHours * 60 * 60 * 1000;

    const stored = this.ctx.globalState.get<LocalCounter>(cfg.key) ?? {
      count: 0,
      windowStart: now,
    };

    // Roll window if expired
    const counter: LocalCounter =
      now - stored.windowStart > windowMs
        ? { count: 0, windowStart: now }
        : stored;

    if (counter.count >= cfg.limit) {
      await this.showLimitReachedMessage(metric, cfg.limit);
      return false;
    }

    counter.count += 1;
    await this.ctx.globalState.update(cfg.key, counter);
    return true;
  }

  private getLocalSummary(): UsageSummary {
    const get = (metric: MetricType): number => {
      const cfg = LOCAL_LIMITS[metric];
      const stored = this.ctx.globalState.get<LocalCounter>(cfg.key);
      if (!stored) return 0;

      const windowMs = cfg.windowHours * 60 * 60 * 1000;
      if (Date.now() - stored.windowStart > windowMs) return 0;
      return stored.count;
    };

    return {
      scansThisMonth: get("SCAN"),
      explanationsToday: get("EXPLANATION"),
      chatQueriesToday: get("CHAT_QUERY"),
    };
  }

  // ── Upgrade prompts ───────────────────────────────────────────────────────────

  private async showLimitReachedMessage(
    metric: MetricType,
    limit: number | null
  ): Promise<void> {
    const labels: Record<MetricType, string> = {
      SCAN: `project scans this month`,
      EXPLANATION: `AI explanations today`,
      CHAT_QUERY: `chat queries today`,
    };

    const limitText = limit !== null ? `${limit} ` : "";
    const action = await vscode.window.showWarningMessage(
      `Zerly: You've used all ${limitText}${labels[metric]} on the Free plan.`,
      "Upgrade to Pro — $9/month",
      "View All Plans",
      "Dismiss"
    );

    const subManager = SubscriptionManager.getInstance();
    if (action === "Upgrade to Pro — $9/month") {
      await subManager.startUpgrade("PRO");
    } else if (action === "View All Plans") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://zerlyai.dev/pricing")
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface UsageSummary {
  scansThisMonth: number;
  explanationsToday: number;
  chatQueriesToday: number;
}
