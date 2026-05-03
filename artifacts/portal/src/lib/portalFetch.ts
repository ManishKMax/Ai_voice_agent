const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

async function parseJsonOrThrow(res: Response) {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Your session expired. Please sign in again.");
  }
  return res.json().catch(() => {
    throw new Error("Unexpected response from server");
  });
}

export async function portalFetch(
  path: string,
  token: string | null,
  opts: RequestInit = {},
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> ?? {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${basePath}${path}`, {
    ...opts,
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("Your session expired. Please sign in again.");
    }
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }

  return parseJsonOrThrow(res);
}
