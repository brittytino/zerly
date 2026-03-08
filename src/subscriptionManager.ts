// src/subscriptionManager.ts
// Gate-checks features against the user's current plan.
// Talks to the /subscriptions/status and /usage/feature-gate endpoints.

import * as vscode from "vscode";
import axios, { AxiosInstance } from "axios";
import { AuthManager, Plan } from "./authManager";

const BACKEND_URL =
  vscode.workspace.getConfiguration("zerly").get<string>("apiUrl") ??
  "https://zerly.tinobritty.me";

// Feature keys that map to the backend planFeatures() object
export type FeatureKey =
  | "projectScan"
  | "architectureMap"
  | "explainCodeBasic"
  | "explainCodeAdvanced"
  | "riskScannerBasic"
  | "deepRiskAnalysis"
  | "architectureHistory"
  | "projectHealthScore"
  | "advancedDebugging"
  | "unlimitedScans"
  | "fasterAiModels"
  | "learningMode"
  | "chatBasic"
  | "sharedDashboards"
  | "teamOnboardingAssistant"
  | "codebaseDocGenerator"
  | "teamRiskMonitoring"
  | "teamKnowledgeBase"
  | "privateAiHosting"
  | "selfHosted"
  | "sso"
  | "securityAuditReports"
  | "complianceMonitoring"
  | "enterpriseSupport";

// Inline feature map — keeps extension working offline/when backend is unreachable
const PLAN_FEATURES: Record<Plan, Set<FeatureKey>> = {
  FREE: new Set([
    "projectScan",
    "architectureMap",
    "explainCodeBasic",
    "riskScannerBasic",
    "learningMode",
    "chatBasic",
  ]),
  PRO: new Set([
    "projectScan",
    "architectureMap",
    "explainCodeBasic",
    "explainCodeAdvanced",
    "riskScannerBasic",
    "deepRiskAnalysis",
    "architectureHistory",
    "projectHealthScore",
    "advancedDebugging",
    "unlimitedScans",
    "fasterAiModels",
    "learningMode",
    "chatBasic",
  ]),
  TEAM: new Set([
    "projectScan",
    "architectureMap",
    "explainCodeBasic",
    "explainCodeAdvanced",
    "riskScannerBasic",
    "deepRiskAnalysis",
    "architectureHistory",
    "projectHealthScore",
    "advancedDebugging",
    "unlimitedScans",
    "fasterAiModels",
    "learningMode",
    "chatBasic",
    "sharedDashboards",
    "teamOnboardingAssistant",
    "codebaseDocGenerator",
    "teamRiskMonitoring",
    "teamKnowledgeBase",
  ]),
  ENTERPRISE: new Set([
    "projectScan",
    "architectureMap",
    "explainCodeBasic",
    "explainCodeAdvanced",
    "riskScannerBasic",
    "deepRiskAnalysis",
    "architectureHistory",
    "projectHealthScore",
    "advancedDebugging",
    "unlimitedScans",
    "fasterAiModels",
    "learningMode",
    "chatBasic",
    "sharedDashboards",
    "teamOnboardingAssistant",
    "codebaseDocGenerator",
    "teamRiskMonitoring",
    "teamKnowledgeBase",
    "privateAiHosting",
    "selfHosted",
    "sso",
    "securityAuditReports",
    "complianceMonitoring",
    "enterpriseSupport",
  ]),
};

const UPGRADE_REQUIRED: Record<FeatureKey, Plan> = {
  projectScan: "FREE",
  architectureMap: "FREE",
  explainCodeBasic: "FREE",
  riskScannerBasic: "FREE",
  learningMode: "FREE",
  chatBasic: "FREE",
  explainCodeAdvanced: "PRO",
  deepRiskAnalysis: "PRO",
  architectureHistory: "PRO",
  projectHealthScore: "PRO",
  advancedDebugging: "PRO",
  unlimitedScans: "PRO",
  fasterAiModels: "PRO",
  sharedDashboards: "TEAM",
  teamOnboardingAssistant: "TEAM",
  codebaseDocGenerator: "TEAM",
  teamRiskMonitoring: "TEAM",
  teamKnowledgeBase: "TEAM",
  privateAiHosting: "ENTERPRISE",
  selfHosted: "ENTERPRISE",
  sso: "ENTERPRISE",
  securityAuditReports: "ENTERPRISE",
  complianceMonitoring: "ENTERPRISE",
  enterpriseSupport: "ENTERPRISE",
};

export class SubscriptionManager {
  private static instance: SubscriptionManager;
  private auth: AuthManager;
  private http: AxiosInstance;

  // Cache fetched status for 5 minutes to avoid hammering the API
  private cachedStatus: SubscriptionStatus | null = null;
  private cacheExpiry = 0;
  private readonly TTL_MS = 5 * 60 * 1000;

  private constructor(auth: AuthManager) {
    this.auth = auth;
    this.http = axios.create({ baseURL: BACKEND_URL });

    // Attach JWT to every request
    this.http.interceptors.request.use(async (cfg) => {
      const token = await this.auth.getToken();
      if (token) cfg.headers.Authorization = `Bearer ${token}`;
      return cfg;
    });
  }

  static getInstance(auth?: AuthManager): SubscriptionManager {
    if (!SubscriptionManager.instance) {
      if (!auth) throw new Error("SubscriptionManager not initialized");
      SubscriptionManager.instance = new SubscriptionManager(auth);
    }
    return SubscriptionManager.instance;
  }

  // ── Core gate check ──────────────────────────────────────────────────────────

  /**
   * Returns true if the current plan has access to the given feature.
   * Falls back to the locally-cached plan when the backend is unavailable.
   */
  async hasFeature(feature: FeatureKey): Promise<boolean> {
    const plan = await this.getCurrentPlan();
    return PLAN_FEATURES[plan].has(feature);
  }

  /**
   * Asserts the user has the feature, shows an upgrade prompt if not.
   * Returns false if the action should be blocked.
   */
  async requireFeature(feature: FeatureKey): Promise<boolean> {
    const has = await this.hasFeature(feature);
    if (!has) {
      await this.showUpgradePrompt(feature);
    }
    return has;
  }

  // ── Subscription status ───────────────────────────────────────────────────────

  async getStatus(): Promise<SubscriptionStatus | null> {
    if (this.cachedStatus && Date.now() < this.cacheExpiry) {
      return this.cachedStatus;
    }

    try {
      const res = await this.http.get<{ subscription: SubscriptionStatus }>(
        "/subscriptions/status"
      );
      this.cachedStatus = res.data.subscription;
      this.cacheExpiry = Date.now() + this.TTL_MS;
      return this.cachedStatus;
    } catch {
      return this.cachedStatus; // serve stale if offline
    }
  }

  async getCurrentPlan(): Promise<Plan> {
    const status = await this.getStatus();
    return (status?.plan as Plan) ?? this.auth.getCachedPlan();
  }

  invalidateCache(): void {
    this.cachedStatus = null;
    this.cacheExpiry = 0;
  }

  // ── Upgrade flow ──────────────────────────────────────────────────────────────

  /**
   * Opens a Stripe Checkout session for the given plan in the system browser.
   */
  async startUpgrade(plan: "PRO" | "TEAM" | "ENTERPRISE"): Promise<void> {
    try {
      const res = await this.http.post<{ url: string }>(
        "/subscriptions/create-checkout",
        { plan }
      );
      await vscode.env.openExternal(vscode.Uri.parse(res.data.url));
    } catch {
      vscode.window.showErrorMessage("Zerly: Unable to start upgrade. Please try again.");
    }
  }

  /** Opens the Stripe billing portal */
  async openBillingPortal(): Promise<void> {
    try {
      const res = await this.http.post<{ url: string }>("/subscriptions/portal");
      await vscode.env.openExternal(vscode.Uri.parse(res.data.url));
    } catch {
      vscode.window.showErrorMessage("Zerly: Unable to open billing portal.");
    }
  }

  // ── Upgrade prompt ────────────────────────────────────────────────────────────

  private async showUpgradePrompt(feature: FeatureKey): Promise<void> {
    const required = UPGRADE_REQUIRED[feature];
    const price = required === "PRO" ? "$9/month" : required === "TEAM" ? "$25/user/month" : "Custom";

    const action = await vscode.window.showInformationMessage(
      `This feature requires the ${required} plan (${price}). Upgrade to unlock it.`,
      "Upgrade Now",
      "View Plans",
      "Dismiss"
    );

    if (action === "Upgrade Now" && required !== "FREE") {
      await this.startUpgrade(required as "PRO" | "TEAM" | "ENTERPRISE");
    } else if (action === "View Plans") {
      await vscode.env.openExternal(vscode.Uri.parse("https://zerly.tinobritty.me/pricing"));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface SubscriptionStatus {
  plan: string;
  status: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  seats?: number;
}
