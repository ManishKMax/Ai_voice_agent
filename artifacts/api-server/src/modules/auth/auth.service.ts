import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq, count } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { config } from "../../config/index.js";
import { createAuditLog } from "../audit/audit.service.js";

export async function registerUser(name: string, email: string, password: string) {
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existing.length > 0) {
    throw new Error("Email already registered");
  }

  // First user registered becomes COMPANY_ADMIN
  const [{ total }] = await db.select({ total: count() }).from(usersTable);
  const isFirstUser = Number(total) === 0;
  const role = isFirstUser ? "COMPANY_ADMIN" : "USER";

  const hashed = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({ name, email, password: hashed, role })
    .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role });

  await createAuditLog({
    userId: user.id,
    action: isFirstUser ? "USER_REGISTERED_AS_COMPANY_ADMIN" : "USER_REGISTERED",
    targetType: "user",
    targetId: user.id,
    metadata: { email, role },
  });

  return user;
}

export async function loginUser(email: string, password: string) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (!user) throw new Error("Invalid credentials");
  if (!user.isActive) throw new Error("Account is deactivated");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new Error("Invalid credentials");

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: "7d" }
  );

  await createAuditLog({
    userId: user.id,
    action: "USER_LOGIN",
    targetType: "user",
    targetId: user.id,
    metadata: { email },
  });

  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}
