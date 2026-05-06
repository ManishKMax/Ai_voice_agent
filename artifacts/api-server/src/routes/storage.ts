import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { Readable } from "stream";
import { getAuth } from "@clerk/express";
import jwt from "jsonwebtoken";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";
import { authMiddleware, requireRole } from "../middlewares/auth.js";
import { config } from "../config/index.js";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * Allow either an admin JWT (Bearer) OR a Clerk-authenticated portal user.
 * Issuing presigned upload URLs without auth would let anyone write to the
 * private bucket.
 */
function requireAnyAuth(req: Request, res: Response, next: NextFunction): void {
  // Try admin JWT
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      jwt.verify(authHeader.slice(7), config.jwtSecret);
      return next();
    } catch {
      // fall through to Clerk
    }
  }
  // Try Clerk
  const clerkAuth = getAuth(req);
  if (clerkAuth?.userId) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
}

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", requireAnyAuth, async (req: Request, res: Response) => {
  const { name, size, contentType } = req.body ?? {};
  if (
    typeof name !== "string" || !name ||
    typeof size !== "number" || size <= 0 ||
    typeof contentType !== "string" || !contentType
  ) {
    res.status(400).json({ error: "Missing or invalid required fields: name, size, contentType" });
    return;
  }

  try {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json({ uploadURL, objectPath, metadata: { name, size, contentType } });
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * Requires authentication — private files only accessible to logged-in users.
 */
// Restricted to COMPANY_ADMIN / SUPER_ADMIN — these are KYC documents and
// other tenant-private files. Tenant self-service access goes through
// separate Clerk-authed portal routes that scope by tenantId.
router.get("/storage/objects/*path", authMiddleware, requireRole("COMPANY_ADMIN", "SUPER_ADMIN"), async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
