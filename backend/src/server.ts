// src/server.ts — Zerly AI monetization backend

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { config } from "./config";
import { authRouter } from "./routes/auth";
import { subscriptionRouter } from "./routes/subscriptions";
import { usageRouter } from "./routes/usage";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

// ── Security & Logging ────────────────────────────────────────────────────────
app.use(helmet());
app.set("trust proxy", 1); // needed for rate-limit IP detection behind Render/Railway

app.use(morgan(config.nodeEnv === "production" ? "combined" : "dev"));
app.use(
  cors({
    origin: [
      /^vscode-webview:\/\//,
      /^vscode:\/\//,
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    credentials: true,
  })
);

// ── Global rate limit ─────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests, slow down." } },
});

// Stricter limit on auth endpoints to prevent credential stuffing
const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many auth attempts." } },
});

app.use(globalLimiter);

// ── Body parsing ─────────────────────────────────────────────────────────────
// Stripe webhooks need the raw body — mount BEFORE json() parser
app.use(
  "/subscriptions/webhook",
  express.raw({ type: "application/json" })
);
app.use(express.json({ limit: "256kb" }));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/auth", authLimiter, authRouter);
app.use("/subscriptions", subscriptionRouter);
app.use("/usage", usageRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", ts: new Date().toISOString() });
});

// ── Error handling ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(
    `[Zerly API] Running on port ${config.port} (${config.nodeEnv})`
  );
});

export default app;
