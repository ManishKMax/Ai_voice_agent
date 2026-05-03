import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { useLocation } from "wouter";

interface AuthContextType {
  token: string | null;
  isAuthenticated: boolean;
  role: string | null;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(localStorage.getItem("auth_token"));
  const [role, setRole] = useState<string | null>(() => {
    const stored = localStorage.getItem("auth_token");
    if (!stored) return null;
    try {
      const payload = JSON.parse(atob(stored.split(".")[1] ?? "")) as { role?: string };
      return payload.role ?? null;
    } catch {
      return null;
    }
  });
  const [, setLocation] = useLocation();

  useEffect(() => {
    setAuthTokenGetter(() => localStorage.getItem("auth_token"));
  }, []);

  const login = (newToken: string) => {
    localStorage.setItem("auth_token", newToken);
    setToken(newToken);
    try {
      const payload = JSON.parse(atob(newToken.split(".")[1] ?? "")) as { role?: string };
      setRole(payload.role ?? null);
    } catch {
      setRole(null);
    }
  };

  const logout = () => {
    localStorage.removeItem("auth_token");
    setToken(null);
    setRole(null);
    setLocation("/login");
  };

  return (
    <AuthContext.Provider value={{ token, isAuthenticated: !!token, role, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
