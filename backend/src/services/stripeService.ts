// src/services/stripeService.ts — Stripe SDK wrapper

import Stripe from "stripe";
import { config } from "../config";
import { db } from "../db";
import { Plan, SubscriptionStatus } from "@prisma/client";

export const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: "2023-10-16",
});

// ── Price ID → Plan mapping ───────────────────────────────────────────────────

const priceToplan: Record<string, Plan> = {
  [config.stripe.prices.proMonthly]: Plan.PRO,
  [config.stripe.prices.teamMonthly]: Plan.TEAM,
  [config.stripe.prices.enterpriseMonthly]: Plan.ENTERPRISE,
};

export function priceIdToPlan(priceId: string): Plan {
  return priceToplan[priceId] ?? Plan.FREE;
}

export function planToPriceId(plan: Plan): string | undefined {
  switch (plan) {
    case Plan.PRO:
      return config.stripe.prices.proMonthly;
    case Plan.TEAM:
      return config.stripe.prices.teamMonthly;
    case Plan.ENTERPRISE:
      return config.stripe.prices.enterpriseMonthly;
    default:
      return undefined;
  }
}

// ── Stripe status → DB status mapping ────────────────────────────────────────

function stripeStatusToDb(status: Stripe.Subscription.Status): SubscriptionStatus {
  const map: Record<string, SubscriptionStatus> = {
    active: SubscriptionStatus.ACTIVE,
    past_due: SubscriptionStatus.PAST_DUE,
    canceled: SubscriptionStatus.CANCELED,
    trialing: SubscriptionStatus.TRIALING,
    incomplete: SubscriptionStatus.INCOMPLETE,
    incomplete_expired: SubscriptionStatus.CANCELED,
    unpaid: SubscriptionStatus.PAST_DUE,
    paused: SubscriptionStatus.PAST_DUE,
  };
  return map[status] ?? SubscriptionStatus.CANCELED;
}

// ── Ensure the user has a Stripe Customer record ──────────────────────────────

export async function getOrCreateStripeCustomer(
  userId: string,
  email: string | null | undefined,
  name: string | null | undefined
): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: email ?? undefined,
    name: name ?? undefined,
    metadata: { zerlyUserId: userId, githubId: user.githubId },
  });

  await db.user.update({
    where: { id: userId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

// ── Sync a Stripe Subscription to our DB ─────────────────────────────────────

export async function syncStripeSubscription(
  stripeSub: Stripe.Subscription,
  userId: string
): Promise<void> {
  const item = stripeSub.items.data[0];
  const priceId = item?.price.id ?? "";
  const plan = priceIdToPlan(priceId);
  const quantity = item?.quantity ?? 1;

  await db.subscription.upsert({
    where: { userId },
    create: {
      userId,
      plan,
      status: stripeStatusToDb(stripeSub.status),
      stripeSubscriptionId: stripeSub.id,
      stripePriceId: priceId,
      seats: quantity,
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    },
    update: {
      plan,
      status: stripeStatusToDb(stripeSub.status),
      stripeSubscriptionId: stripeSub.id,
      stripePriceId: priceId,
      seats: quantity,
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    },
  });
}

// ── Resolve userId from a Stripe Customer ID ──────────────────────────────────

export async function userIdFromCustomer(customerId: string): Promise<string | null> {
  const user = await db.user.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  return user?.id ?? null;
}
