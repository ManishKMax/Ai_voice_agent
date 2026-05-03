import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import type { UserRole } from "@workspace/db/schema";

export interface AuthRequest extends Request {
  userId?: number;
  userEmail?: string;
  userRole?: UserRole;
}

export function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.jwtSecret) as {
      userId: number;
      email: string;
      role?: UserRole;
    };
    req.userId = payload.userId;
    req.userEmail = payload.email;
    req.userRole = payload.role ?? "USER";
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}
