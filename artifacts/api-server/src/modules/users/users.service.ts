import bcrypt from "bcryptjs";
import { eq, ne, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable, type UserRole } from "@workspace/db/schema";
import { createAuditLog } from "../audit/audit.service.js";

export async function listUsers() {
  return db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(desc(usersTable.createdAt));
}

export async function getUserById(id: number) {
  const [user] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  return user ?? null;
}

export async function createUser(
  actorId: number,
  data: { name: string; email: string; password: string; role?: UserRole }
) {
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, data.email))
    .limit(1);

  if (existing) throw new Error("Email already registered");

  const hashed = await bcrypt.hash(data.password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({
      name: data.name,
      email: data.email,
      password: hashed,
      role: data.role ?? "USER",
    })
    .returning({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    });

  await createAuditLog({
    userId: actorId,
    action: "ADMIN_CREATED_USER",
    targetType: "user",
    targetId: user.id,
    metadata: { email: data.email, role: data.role ?? "USER" },
  });

  return user;
}

export async function updateUserRole(actorId: number, userId: number, role: UserRole) {
  const [user] = await db
    .update(usersTable)
    .set({ role, updatedAt: new Date() })
    .where(eq(usersTable.id, userId))
    .returning({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      isActive: usersTable.isActive,
    });

  if (!user) throw new Error("User not found");

  await createAuditLog({
    userId: actorId,
    action: "ADMIN_UPDATED_USER_ROLE",
    targetType: "user",
    targetId: userId,
    metadata: { role },
  });

  return user;
}

export async function toggleUserActive(actorId: number, userId: number, isActive: boolean) {
  if (actorId === userId) throw new Error("Cannot deactivate your own account");

  const [user] = await db
    .update(usersTable)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(usersTable.id, userId))
    .returning({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      isActive: usersTable.isActive,
    });

  if (!user) throw new Error("User not found");

  await createAuditLog({
    userId: actorId,
    action: isActive ? "ADMIN_ACTIVATED_USER" : "ADMIN_DEACTIVATED_USER",
    targetType: "user",
    targetId: userId,
  });

  return user;
}

export async function deleteUser(actorId: number, userId: number) {
  if (actorId === userId) throw new Error("Cannot delete your own account");

  const [user] = await db
    .delete(usersTable)
    .where(eq(usersTable.id, userId))
    .returning({ id: usersTable.id, email: usersTable.email });

  if (!user) throw new Error("User not found");

  await createAuditLog({
    userId: actorId,
    action: "ADMIN_DELETED_USER",
    targetType: "user",
    targetId: userId,
    metadata: { email: user.email },
  });

  return user;
}

export async function resetUserPassword(actorId: number, userId: number, newPassword: string) {
  const hashed = await bcrypt.hash(newPassword, 10);
  const [user] = await db
    .update(usersTable)
    .set({ password: hashed, updatedAt: new Date() })
    .where(eq(usersTable.id, userId))
    .returning({ id: usersTable.id, email: usersTable.email });

  if (!user) throw new Error("User not found");

  await createAuditLog({
    userId: actorId,
    action: "ADMIN_RESET_USER_PASSWORD",
    targetType: "user",
    targetId: userId,
  });

  return user;
}
