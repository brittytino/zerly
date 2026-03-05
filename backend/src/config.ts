// src/config.ts — centralised runtime configuration with env validation

import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export const config = {
  port: Number(optional("PORT", "3000")),
  nodeEnv: optional("NODE_ENV", "development"),

  jwt: {
    accessSecret: required("JWT_SECRET"),
    refreshSecret: required("JWT_REFRESH_SECRET"),
    accessExpiresIn: optional("JWT_ACCESS_EXPIRES_IN", "1h"),
    refreshExpiresIn: optional("JWT_REFRESH_EXPIRES_IN", "7d"),
    // Numeric seconds for refresh token DB expiry
    refreshExpiresSeconds: Number(optional("JWT_REFRESH_EXPIRES_SECONDS", String(7 * 24 * 60 * 60))),
  },

  github: {
    clientId: required("GITHUB_CLIENT_ID"),
    clientSecret: required("GITHUB_CLIENT_SECRET"),
    redirectUri: required("GITHUB_REDIRECT_URI"),
  },

  stripe: {
    secretKey: required("STRIPE_SECRET_KEY"),
    webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
    prices: {
      proMonthly: required("STRIPE_PRICE_PRO_MONTHLY"),
      teamMonthly: required("STRIPE_PRICE_TEAM_MONTHLY"),
      enterpriseMonthly: optional("STRIPE_PRICE_ENTERPRISE_MONTHLY"),
    },
  },

  frontendUrl: optional("FRONTEND_URL", "vscode://zerlyai.zerly"),

  // Rate limits
  rateLimit: {
    windowMs: Number(optional("RATE_LIMIT_WINDOW_MS", String(15 * 60 * 1000))), // 15 min
    max: Number(optional("RATE_LIMIT_MAX", "120")),
    authMax: Number(optional("RATE_LIMIT_AUTH_MAX", "20")),
  },

  // Free tier hard limits
  limits: {
    free: {
      scansPerMonth: 30,
      explanationsPerDay: 10,
      chatQueriesPerDay: 20,
    },
  },
} as const;

export type Config = typeof config;
