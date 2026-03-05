// src/routes/usage.ts — usage tracking and gate-checking endpoints

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { db } from "../db";
import { authenticate } from "../middleware/authenticate";
import {
  checkAndIncrement,
  getUsageSummary,
  type MetricType,
} from "../services/usageService";
import { planLimits, planFeatures } from "../routes/subscriptions";
import { Plan } from "@prisma/client";

const METRIC_VALUES = ["SCAN", "EXPLANATION", "CHAT_QUERY"] as const;

export const usageRouter = Router();

// All usage routes require authentication
usageRouter.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// GET /usage/current
// Returns a snapshot of the user's current usage windows + limits
// ─────────────────────────────────────────────────────────────────────────────
usageRouter.get(
  "/current",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [usage, subscription] = await Promise.all([
        getUsageSummary(req.user!.id),
        db.subscription.findUnique({
          where: { userId: req.user!.id },
          select: { plan: true },
        }),
      ]);

      const plan = subscription?.plan ?? Plan.FREE;
      const limits = planLimits(plan);

      res.json({
        plan,
        usage,
        limits,
        // Convenience: percentage consumed (null = unlimited)
        percentConsumed: {
          scans:
            limits.scansPerMonth != null
              ? Math.round((usage.scansThisMonth / limits.scansPerMonth) * 100)
              : null,
          explanations:
            limits.explanationsPerDay != null
              ? Math.round((usage.explanationsToday / limits.explanationsPerDay) * 100)
              : null,
          chatQueries:
            limits.chatQueriesPerDay != null
              ? Math.round(((usage.chatQueriesToday) / limits.chatQueriesPerDay) * 100)
              : null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /usage/track
// Records a usage event AND enforces limits.
// Returns { allowed, count, limit } — 429 if limit exceeded.
// Body: { metric: "SCAN" | "EXPLANATION" | "CHAT_QUERY" }
// ─────────────────────────────────────────────────────────────────────────────
const TrackBody = z.object({
  metric: z.enum(METRIC_VALUES),
});

usageRouter.post(
  "/track",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = TrackBody.parse(req.body);

      // Fetch current plan from DB (authoritative — not JWT payload)
      const subscription = await db.subscription.findUnique({
        where: { userId: req.user!.id },
        select: { plan: true },
      });
      const plan = subscription?.plan ?? Plan.FREE;

      const result = await checkAndIncrement(req.user!.id, plan, body.metric as MetricType);

      if (!result.allowed) {
        res.status(429).json({
          error: {
            code: "LIMIT_EXCEEDED",
            message: `${body.metric} limit reached for the ${plan} plan`,
            count: result.count,
            limit: result.limit,
          },
        });
        return;
      }

      res.json({
        allowed: true,
        metric: body.metric,
        count: result.count,
        limit: result.limit,
        plan,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /usage/check
// Pre-flight check: can the user perform an action?
// Does NOT increment the counter.
// Body: { metric: "SCAN" | "EXPLANATION" | "CHAT_QUERY" }
// ─────────────────────────────────────────────────────────────────────────────
usageRouter.post(
  "/check",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = TrackBody.parse(req.body);

      const subscription = await db.subscription.findUnique({
        where: { userId: req.user!.id },
        select: { plan: true },
      });
      const plan = subscription?.plan ?? Plan.FREE;
      const limits = planLimits(plan);

      const limitKey =
        body.metric === "SCAN"
          ? "scansPerMonth"
          : body.metric === "EXPLANATION"
          ? "explanationsPerDay"
          : "chatQueriesPerDay";

      const limit = limits[limitKey] as number | null;

      if (limit === null) {
        res.json({ allowed: true, limit: null, plan });
        return;
      }

      const usage = await getUsageSummary(req.user!.id);
      const current =
        body.metric === "SCAN"
          ? usage.scansThisMonth
          : body.metric === "EXPLANATION"
          ? usage.explanationsToday
          : usage.chatQueriesToday;

      res.json({ allowed: current < limit, count: current, limit, plan });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /usage/feature-gate/:feature
// Returns whether a named feature is available on the user's current plan
// ─────────────────────────────────────────────────────────────────────────────
usageRouter.get(
  "/feature-gate/:feature",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subscription = await db.subscription.findUnique({
        where: { userId: req.user!.id },
        select: { plan: true },
      });
      const plan = subscription?.plan ?? Plan.FREE;
      const features = planFeatures(plan);
      const featureKey = req.params.feature;

      const enabled = features[featureKey] === true;

      res.json({
        feature: featureKey,
        enabled,
        plan,
        requiredPlan: resolveRequiredPlan(featureKey),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Helper — which minimum plan unlocks a feature
// ─────────────────────────────────────────────────────────────────────────────
function resolveRequiredPlan(feature: string): Plan {
  const enterpriseOnly = new Set([
    "privateAiHosting",
    "selfHosted",
    "sso",
    "securityAuditReports",
    "complianceMonitoring",
    "enterpriseSupport",
  ]);
  const teamPlus = new Set([
    "sharedDashboards",
    "teamOnboardingAssistant",
    "codebaseDocGenerator",
    "teamRiskMonitoring",
    "teamKnowledgeBase",
  ]);
  const proPlus = new Set([
    "explainCodeAdvanced",
    "deepRiskAnalysis",
    "architectureHistory",
    "projectHealthScore",
    "advancedDebugging",
    "unlimitedScans",
    "fasterAiModels",
  ]);

  if (enterpriseOnly.has(feature)) return Plan.ENTERPRISE;
  if (teamPlus.has(feature)) return Plan.TEAM;
  if (proPlus.has(feature)) return Plan.PRO;
  return Plan.FREE;
}
