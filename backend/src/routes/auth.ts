// src/routes/auth.ts — GitHub OAuth login and token refresh

import { Router, Request, Response, NextFunction } from "express";
import axios from "axios";
import { db } from "../db";
import { config } from "../config";
import {
  authenticate,
  signAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
} from "../middleware/authenticate";
import { Plan } from "@prisma/client";

export const authRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Redirect user to GitHub authorization endpoint
// VS Code extension opens this URL in the system browser
// GET /auth/github
// ─────────────────────────────────────────────────────────────────────────────
authRouter.get("/github", (_req: Request, res: Response) => {
  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: config.github.redirectUri,
    scope: "read:user user:email",
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: GitHub redirects back here with ?code=...
// Exchange code → access_token → fetch GitHub profile → upsert user → issue JWT
// GET /auth/github/callback
// ─────────────────────────────────────────────────────────────────────────────
authRouter.get(
  "/github/callback",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.query.code as string | undefined;
      if (!code) {
        res.status(400).json({ error: { code: "MISSING_CODE", message: "Missing OAuth code" } });
        return;
      }

      // Exchange code for GitHub access token
      const tokenResponse = await axios.post<{ access_token: string }>(
        "https://github.com/login/oauth/access_token",
        {
          client_id: config.github.clientId,
          client_secret: config.github.clientSecret,
          code,
          redirect_uri: config.github.redirectUri,
        },
        { headers: { Accept: "application/json" } }
      );

      const githubAccessToken = tokenResponse.data.access_token;
      if (!githubAccessToken) {
        res.status(400).json({ error: { code: "OAUTH_FAILED", message: "Failed to obtain GitHub token" } });
        return;
      }

      // Fetch GitHub user profile
      const [profileRes, emailsRes] = await Promise.all([
        axios.get<GitHubProfile>("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${githubAccessToken}` },
        }),
        axios.get<GitHubEmail[]>("https://api.github.com/user/emails", {
          headers: { Authorization: `Bearer ${githubAccessToken}` },
        }),
      ]);

      const profile = profileRes.data;
      const primaryEmail =
        emailsRes.data.find((e) => e.primary && e.verified)?.email ??
        profile.email ??
        undefined;

      // Upsert user + ensure they have a subscription record
      const user = await db.user.upsert({
        where: { githubId: String(profile.id) },
        create: {
          githubId: String(profile.id),
          githubLogin: profile.login,
          name: profile.name ?? profile.login,
          email: primaryEmail,
          avatarUrl: profile.avatar_url,
          subscription: { create: { plan: Plan.FREE } },
          usageMetric: { create: {} },
        },
        update: {
          githubLogin: profile.login,
          name: profile.name ?? profile.login,
          email: primaryEmail,
          avatarUrl: profile.avatar_url,
        },
        include: { subscription: { select: { plan: true } } },
      });

      // Ensure usage row exists for older users that pre-date this schema
      await db.usageMetric.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });

      const plan = user.subscription?.plan ?? Plan.FREE;

      // Issue short-lived access token + long-lived refresh token
      const accessToken = signAccessToken(user.id, user.githubId, plan);
      const refreshToken = generateRefreshToken();
      await storeRefreshToken(user.id, refreshToken, req);

      // Deep-link back into VS Code:
      // vscode://zerlyai.zerly/auth?token=...&refreshToken=...&plan=...
      const redirectUrl =
        `${config.frontendUrl}/auth` +
        `?token=${encodeURIComponent(accessToken)}` +
        `&refreshToken=${encodeURIComponent(refreshToken)}` +
        `&plan=${plan}`;
      res.redirect(redirectUrl);
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/me — return authenticated user's profile + current plan
// ─────────────────────────────────────────────────────────────────────────────
authRouter.get(
  "/me",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await db.user.findUnique({
        where: { id: req.user!.id },
        select: {
          id: true,
          githubLogin: true,
          name: true,
          email: true,
          avatarUrl: true,
          createdAt: true,
          subscription: {
            select: {
              plan: true,
              status: true,
              currentPeriodEnd: true,
              seats: true,
              cancelAtPeriodEnd: true,
            },
          },
        },
      });

      if (!user) {
        res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
        return;
      }

      res.json({ user });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/refresh — exchange refresh token → new access + refresh token pair
// Body: { refreshToken: string }
// ─────────────────────────────────────────────────────────────────────────────
authRouter.post(
  "/refresh",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body as { refreshToken?: string };

      if (!refreshToken) {
        res.status(400).json({
          error: { code: "MISSING_TOKEN", message: "refreshToken is required" },
        });
        return;
      }

      const userId = await validateRefreshToken(refreshToken);
      if (!userId) {
        res.status(401).json({
          error: { code: "INVALID_REFRESH", message: "Refresh token is invalid or expired" },
        });
        return;
      }

      // Single-use rotation: revoke the consumed token
      await revokeRefreshToken(refreshToken);

      const [subscription, user] = await Promise.all([
        db.subscription.findUnique({ where: { userId }, select: { plan: true } }),
        db.user.findUnique({ where: { id: userId }, select: { githubId: true } }),
      ]);

      if (!user) {
        res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
        return;
      }

      const plan = subscription?.plan ?? Plan.FREE;
      const newAccessToken = signAccessToken(userId, user.githubId, plan);
      const newRefreshToken = generateRefreshToken();
      await storeRefreshToken(userId, newRefreshToken, req);

      res.json({ token: newAccessToken, refreshToken: newRefreshToken, plan });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/logout — revoke all refresh tokens (logs out every session)
// ─────────────────────────────────────────────────────────────────────────────
authRouter.post(
  "/logout",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await revokeAllRefreshTokens(req.user!.id);
      res.json({ message: "Logged out from all sessions" });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}
