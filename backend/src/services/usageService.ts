// src/services/usageService.ts
// Single-row-per-user usage model with auto-resetting windows.
// One UsageMetric row per user. Counters are reset in-place when the
// calendar month (scans) or UTC day (explanations, chat) rolls over.

import { db } from "../db";
import { Plan } from "@prisma/client";
import { planLimits } from "../routes/subscriptions";

export type MetricType = "SCAN" | "EXPLANATION" | "CHAT_QUERY";

// â”€â”€ Window helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function currentDayKey(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function startOfThisMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfToday(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// â”€â”€ Core: get-or-create and auto-reset â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Fetches the usage row for a user, creates it if missing, and resets
 * stale windows in-place. Returns the up-to-date row.
 */
async function getAndResetUsageRow(userId: string) {
  const monthStart = startOfThisMonth();
  const dayStart   = startOfToday();

  // Fetch existing row
  let row = await db.usageMetric.findUnique({ where: { userId } });

  if (!row) {
    // First time â€” create a fresh row
    return db.usageMetric.create({
      data: {
        userId,
        scansThisMonth: 0,
        explanationsToday: 0,
        chatToday: 0,
        lastResetMonthly: monthStart,
        lastResetDaily: dayStart,
      },
    });
  }

  // Determine which fields need resetting
  const needsMonthlyReset = row.lastResetMonthly < monthStart;
  const needsDailyReset   = row.lastResetDaily < dayStart;

  if (!needsMonthlyReset && !needsDailyReset) {
    return row; // no reset needed
  }

  return db.usageMetric.update({
    where: { userId },
    data: {
      ...(needsMonthlyReset
        ? { scansThisMonth: 0, lastResetMonthly: monthStart }
        : {}),
      ...(needsDailyReset
        ? { explanationsToday: 0, chatToday: 0, lastResetDaily: dayStart }
        : {}),
    },
  });
}

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Returns the current counts for a user after applying any pending resets.
 */
export async function getUsageCounts(userId: string): Promise<UsageCounts> {
  const row = await getAndResetUsageRow(userId);
  return {
    scansThisMonth: row.scansThisMonth,
    explanationsToday: row.explanationsToday,
    chatToday: row.chatToday,
  };
}

/**
 * Pre-flight: can the user perform a metric action?
 * Returns { allowed, count, limit }.
 */
export async function checkLimit(
  userId: string,
  plan: Plan,
  metric: MetricType
): Promise<LimitCheck> {
  const limits = planLimits(plan);
  const limitKey = metricToLimitKey(metric);
  const limit = limits[limitKey] as number | null;

  if (limit === null) {
    return { allowed: true, count: 0, limit: null };
  }

  const counts = await getUsageCounts(userId);
  const count  = metricToCount(metric, counts);
  return { allowed: count < limit, count, limit };
}

/**
 * Checks the limit and, if allowed, atomically increments the counter.
 * Returns the updated check result.
 */
export async function checkAndIncrement(
  userId: string,
  plan: Plan,
  metric: MetricType
): Promise<LimitCheck> {
  // Ensure row is reset-clean before we read+write
  const row = await getAndResetUsageRow(userId);

  const limits   = planLimits(plan);
  const limitKey = metricToLimitKey(metric);
  const limit    = limits[limitKey] as number | null;
  const count    = metricToCount(metric, {
    scansThisMonth: row.scansThisMonth,
    explanationsToday: row.explanationsToday,
    chatToday: row.chatToday,
  });

  if (limit !== null && count >= limit) {
    return { allowed: false, count, limit };
  }

  // Atomically increment
  const updated = await db.usageMetric.update({
    where: { userId },
    data: { [metricToField(metric)]: { increment: 1 } },
  });

  const newCount = metricToCount(metric, {
    scansThisMonth: updated.scansThisMonth,
    explanationsToday: updated.explanationsToday,
    chatToday: updated.chatToday,
  });

  return { allowed: true, count: newCount, limit };
}

/**
 * Returns a complete usage summary with window reset timestamps.
 */
export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  const counts = await getUsageCounts(userId);
  const now    = new Date();

  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const tomorrowStart  = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  ));

  return {
    scansThisMonth: counts.scansThisMonth,
    explanationsToday: counts.explanationsToday,
    chatQueriesToday: counts.chatToday,
    windowResets: {
      scans:       nextMonthStart,
      explanations: tomorrowStart,
      chatQueries:  tomorrowStart,
    },
  };
}

// â”€â”€ Internal helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function metricToLimitKey(metric: MetricType): string {
  return metric === "SCAN"
    ? "scansPerMonth"
    : metric === "EXPLANATION"
    ? "explanationsPerDay"
    : "chatQueriesPerDay";
}

function metricToField(metric: MetricType): string {
  return metric === "SCAN"
    ? "scansThisMonth"
    : metric === "EXPLANATION"
    ? "explanationsToday"
    : "chatToday";
}

function metricToCount(metric: MetricType, counts: UsageCounts): number {
  return metric === "SCAN"
    ? counts.scansThisMonth
    : metric === "EXPLANATION"
    ? counts.explanationsToday
    : counts.chatToday;
}

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface UsageCounts {
  scansThisMonth: number;
  explanationsToday: number;
  chatToday: number;
}

export interface LimitCheck {
  allowed: boolean;
  count: number;
  limit: number | null;
}

export interface UsageSummary {
  scansThisMonth: number;
  explanationsToday: number;
  chatQueriesToday: number;
  windowResets: {
    scans: Date;
    explanations: Date;
    chatQueries: Date;
  };
}
