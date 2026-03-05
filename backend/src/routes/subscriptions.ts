// src/routes/subscriptions.ts — subscription management endpoints

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { db } from "../db";
import { config } from "../config";
import { authenticate } from "../middleware/authenticate";
import {
  stripe,
  planToPriceId,
  getOrCreateStripeCustomer,
  syncStripeSubscription,
  userIdFromCustomer,
} from "../services/stripeService";
import { Plan, SubscriptionStatus } from "@prisma/client";
import Stripe from "stripe";

export const subscriptionRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /subscriptions/status
// Returns the authenticated user's current plan, status and limits
// ─────────────────────────────────────────────────────────────────────────────
subscriptionRouter.get(
  "/status",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subscription = await db.subscription.findUnique({
        where: { userId: req.user!.id },
        select: {
          plan: true,
          status: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          seats: true,
          selfHosted: true,
          ssoDomain: true,
        },
      });

      const plan = subscription?.plan ?? Plan.FREE;

      res.json({
        subscription: subscription ?? { plan: Plan.FREE, status: "ACTIVE" },
        features: planFeatures(plan),
        limits: planLimits(plan),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /subscriptions/create-checkout
// Creates a Stripe Checkout Session for plan upgrade
// Body: { plan: "PRO" | "TEAM" | "ENTERPRISE", seats?: number }
// ─────────────────────────────────────────────────────────────────────────────
const CheckoutBody = z.object({
  plan: z.enum(["PRO", "TEAM", "ENTERPRISE"]),
  seats: z.number().int().min(1).optional().default(1),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

subscriptionRouter.post(
  "/create-checkout",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = CheckoutBody.parse(req.body);
      const user = await db.user.findUnique({
        where: { id: req.user!.id },
        select: { id: true, email: true, name: true },
      });
      if (!user) {
        res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
        return;
      }

      const priceId = planToPriceId(body.plan as Plan);
      if (!priceId) {
        res.status(400).json({ error: { code: "INVALID_PLAN", message: "Contact sales for Enterprise" } });
        return;
      }

      const customerId = await getOrCreateStripeCustomer(
        user.id,
        user.email,
        user.name
      );

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: body.seats }],
        metadata: { zerlyUserId: user.id, plan: body.plan },
        success_url:
          body.successUrl ??
          `${config.frontendUrl}/upgrade-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:
          body.cancelUrl ?? `${config.frontendUrl}/upgrade-cancelled`,
        allow_promotion_codes: true,
        subscription_data: {
          metadata: { zerlyUserId: user.id },
        },
      });

      res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /subscriptions/portal
// Opens the Stripe Customer Portal so users can manage / cancel their sub
// ─────────────────────────────────────────────────────────────────────────────
subscriptionRouter.post(
  "/portal",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await db.user.findUnique({
        where: { id: req.user!.id },
        select: { stripeCustomerId: true },
      });

      if (!user?.stripeCustomerId) {
        res.status(400).json({
          error: { code: "NO_SUBSCRIPTION", message: "No active subscription found" },
        });
        return;
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${config.frontendUrl}/settings`,
      });

      res.json({ url: session.url });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /subscriptions/webhook
// Stripe sends events here — must be mounted with raw body parser (see server.ts)
// ─────────────────────────────────────────────────────────────────────────────
subscriptionRouter.post(
  "/webhook",
  async (req: Request, res: Response, next: NextFunction) => {
    const sig = req.headers["stripe-signature"] as string;
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        sig,
        config.stripe.webhookSecret
      );
    } catch {
      res.status(400).json({ error: "Invalid webhook signature" });
      return;
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.mode === "subscription" && session.subscription) {
            const userId = session.metadata?.zerlyUserId;
            if (userId) {
              const stripeSub = await stripe.subscriptions.retrieve(
                session.subscription as string
              );
              await syncStripeSubscription(stripeSub, userId);
            }
          }
          break;
        }

        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const stripeSub = event.data.object as Stripe.Subscription;
          const userId = await userIdFromCustomer(stripeSub.customer as string);
          if (userId) {
            await syncStripeSubscription(stripeSub, userId);

            // Downgrade to FREE when subscription is canceled/deleted
            if (event.type === "customer.subscription.deleted") {
              await db.subscription.update({
                where: { userId },
                data: { plan: Plan.FREE },
              });
            }
          }
          break;
        }

        case "invoice.payment_succeeded": {
          // Keep subscription status as ACTIVE after a successful renewal
          const invoice = event.data.object as Stripe.Invoice;
          if (invoice.subscription) {
            const userId = await userIdFromCustomer(invoice.customer as string);
            if (userId) {
              const stripeSub = await stripe.subscriptions.retrieve(
                invoice.subscription as string
              );
              await syncStripeSubscription(stripeSub, userId);
            }
          }
          break;
        }

        case "invoice.payment_failed": {
          // Mark subscription as PAST_DUE ; do NOT downgrade yet (Stripe retries)
          const invoice = event.data.object as Stripe.Invoice;
          const userId = await userIdFromCustomer(invoice.customer as string);
          if (userId) {
            await db.subscription.updateMany({
              where: { userId },
              data: { status: SubscriptionStatus.PAST_DUE },
            });
          }
          break;
        }
      }

      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /subscriptions/upgrade-options
// Returns available plans with pricing and features for the upgrade UI
// ─────────────────────────────────────────────────────────────────────────────
subscriptionRouter.get("/upgrade-options", (_req: Request, res: Response) => {
  res.json({
    plans: [
      {
        id: "FREE",
        name: "Free",
        price: 0,
        billing: "forever",
        features: planFeatures(Plan.FREE),
        limits: planLimits(Plan.FREE),
      },
      {
        id: "PRO",
        name: "Pro Developer",
        price: 9,
        billing: "per month",
        features: planFeatures(Plan.PRO),
        limits: planLimits(Plan.PRO),
      },
      {
        id: "TEAM",
        name: "Team",
        price: 25,
        billing: "per user / month",
        features: planFeatures(Plan.TEAM),
        limits: planLimits(Plan.TEAM),
      },
      {
        id: "ENTERPRISE",
        name: "Enterprise",
        price: null,
        billing: "custom",
        features: planFeatures(Plan.ENTERPRISE),
        limits: planLimits(Plan.ENTERPRISE),
        cta: "Contact Sales",
      },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — plan feature gates and limits
// Single source of truth consumed by the API and the extension
// ─────────────────────────────────────────────────────────────────────────────

export function planFeatures(plan: Plan): Record<string, boolean> {
  const base = {
    projectScan: true,
    architectureMap: true,
    explainCodeBasic: true,
    riskScannerBasic: true,
    learningMode: true,
    chatBasic: true,
  };

  if (plan === Plan.FREE) return base;

  const pro = {
    ...base,
    explainCodeAdvanced: true,
    deepRiskAnalysis: true,
    architectureHistory: true,
    projectHealthScore: true,
    advancedDebugging: true,
    unlimitedScans: true,
    fasterAiModels: true,
  };

  if (plan === Plan.PRO) return pro;

  const team = {
    ...pro,
    sharedDashboards: true,
    teamOnboardingAssistant: true,
    codebaseDocGenerator: true,
    teamRiskMonitoring: true,
    teamKnowledgeBase: true,
  };

  if (plan === Plan.TEAM) return team;

  // Enterprise
  return {
    ...team,
    privateAiHosting: true,
    selfHosted: true,
    sso: true,
    securityAuditReports: true,
    complianceMonitoring: true,
    enterpriseSupport: true,
  };
}

export function planLimits(plan: Plan): Record<string, number | null> {
  if (plan === Plan.FREE) {
    return {
      scansPerMonth: config.limits.free.scansPerMonth,
      explanationsPerDay: config.limits.free.explanationsPerDay,
      chatQueriesPerDay: config.limits.free.chatQueriesPerDay,
    };
  }

  // All paid plans — null means unlimited
  return {
    scansPerMonth: null,
    explanationsPerDay: null,
    chatQueriesPerDay: null,
  };
}
