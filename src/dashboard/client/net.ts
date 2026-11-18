// The one way the page talks to the server: same-origin fetch with the session cookie (sent
// by the browser) and the CSRF token. Handles the three security interrupts in one place.
import { session } from "./auth.ts";

export const hooks = {
  /** The session ended or was revoked. */
  unauthorized: () => {},
  /** A sensitive action needs a fresh password or MFA code; resolves true when confirmed. */
  reauth: async (): Promise<boolean> => false,
  /** The organisation requires MFA and this user has not set it up. */
  enroll: () => {},
};

export async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: {
      "x-csrf-token": session.info?.csrf ?? "",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await r.json().catch(() => ({}))) as T & {
    error?: string;
    reauth?: boolean;
    mfaEnrollmentRequired?: boolean;
  };
  if (r.status === 401) {
    hooks.unauthorized();
    throw new Error("Your session has ended.");
  }
  if (r.status === 403 && body.reauth && !retried) {
    if (await hooks.reauth()) return api<T>(path, init, true);
    throw new Error("Cancelled: this action needs you to confirm it's you.");
  }
  if (r.status === 403 && body.mfaEnrollmentRequired) {
    hooks.enroll();
    throw new Error(body.error ?? "Set up two-factor authentication to continue.");
  }
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export const post = <T>(path: string, data: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });
