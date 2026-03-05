// src/middleware/authenticate.ts — JWT bearer token guard + refresh token utilities

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { config } from "../config";
import { db } from "../db";

export interface JwtPayload {
  sub: string;   // user.id (cuid)
  githubId: string;
  plan: string;
  iat: number;
  exp: number;
}

// Augment Express request so downstream handlers can access req.user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        githubId: string;
        plan: string;
      };
    }
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token" } });
      return;
    }

    const token = header.slice(7);
    const payload = jwt.verify(token, config.jwt.accessSecret) as JwtPayload;

    // Attach lightweight user context — plan embedded in JWT, refreshed on login / plan change.
    req.user = {
      id: payload.sub,
      githubId: payload.githubId,
      plan: payload.plan,
    };

    next();
  } catch {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Invalid or expired token" } });
  }
}

// ── Access token factory ───────────────────────────────────────────────────────

export function signAccessToken(userId: string, githubId: string, plan: string): string {
  return jwt.sign(
    { sub: userId, githubId, plan },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiresIn } as jwt.SignOptions
  );
}

// ── Refresh token utilities ────────────────────────────────────────────────────

/** Generate a cryptographically random 48-byte hex token (96 chars). */
export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("hex");
}

/** Persist a refresh token in the DB, bound to a user. Expires in refreshExpiresSeconds. */
export async function storeRefreshToken(
  userId: string,
  token: string,
  req: Request
): Promise<void> {
  const expiresAt = new Date(Date.now() + config.jwt.refreshExpiresSeconds * 1000);
  await db.refreshToken.create({
    data: {
      token,
      userId,
      expiresAt,
      userAgent: req.headers["user-agent"] ?? null,
      ipAddress: (req.ip ?? null),
    },
  });
}

/**
 * Validate a refresh token.
 * Returns the associated userId on success, null on failure.
 */
export async function validateRefreshToken(token: string): Promise<string | null> {
  const record = await db.refreshToken.findUnique({ where: { token } });
  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt < new Date()) return null;
  return record.userId;
}

/** Single-use rotation: revoke the consumed token. */
export async function revokeRefreshToken(token: string): Promise<void> {
  await db.refreshToken.updateMany({
    where: { token, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revoke ALL refresh tokens for a user (logout from all devices). */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
