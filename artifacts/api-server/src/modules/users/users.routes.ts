import { Router } from "express";
import { authMiddleware, requireRole } from "../../middlewares/auth.js";
import {
  listUsers,
  getUserById,
  createUser,
  updateUserRole,
  toggleUserActive,
  deleteUser,
  resetUserPassword,
} from "./users.service.js";
import type { AuthRequest } from "../../middlewares/auth.js";
import type { UserRole } from "@workspace/db/schema";

const router = Router();

router.use(authMiddleware, requireRole("SUPER_ADMIN", "COMPANY_ADMIN"));

router.get("/", async (_req, res, next): Promise<void> => {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next): Promise<void> => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid user ID" }); return; }
    const user = await getUserById(id);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req: AuthRequest, res, next): Promise<void> => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ error: "name, email, and password are required" });
      return;
    }
    const user = await createUser(req.userId!, { name, email, password, role });
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/role", async (req: AuthRequest, res, next): Promise<void> => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid user ID" }); return; }
    const { role } = req.body;
    if (!["SUPER_ADMIN", "COMPANY_ADMIN", "USER"].includes(role)) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }
    const user = await updateUserRole(req.userId!, id, role as UserRole);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/active", async (req: AuthRequest, res, next): Promise<void> => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid user ID" }); return; }
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean" });
      return;
    }
    const user = await toggleUserActive(req.userId!, id, isActive);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/password", async (req: AuthRequest, res, next): Promise<void> => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid user ID" }); return; }
    const { password } = req.body;
    if (!password || password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }
    const user = await resetUserPassword(req.userId!, id, password);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req: AuthRequest, res, next): Promise<void> => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid user ID" }); return; }
    const user = await deleteUser(req.userId!, id);
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

export default router;
