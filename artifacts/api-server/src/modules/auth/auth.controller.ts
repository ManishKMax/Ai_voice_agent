import type { Request, Response } from "express";
import { registerUser, loginUser } from "./auth.service.js";

export async function register(req: Request, res: Response): Promise<void> {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ error: "name, email, and password are required" });
      return;
    }
    const user = await registerUser(name, email, password);
    res.status(201).json({ message: "User registered", user });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Registration failed";
    res.status(400).json({ error: msg });
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }
    const result = await loginUser(email, password);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Login failed";
    res.status(401).json({ error: msg });
  }
}
