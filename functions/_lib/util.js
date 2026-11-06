// Small helpers shared by the API.

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// a 6-digit code without the bias of a plain modulo
export function randomCode() {
  const max = 4_000_000_000; // largest multiple of 10^6 below 2^32
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n < max) return String(n % 1_000_000).padStart(6, "0");
  }
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// compares secrets without leaking how many characters matched
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function readBody(request, maxBytes = 64 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "too_large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

export const parse = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
