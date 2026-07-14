export const API_BASE = import.meta.env.VITE_API_BASE || "";

const AUTH_TOKEN_KEY = "sentaurus_auth_token";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

function token(): string {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function setAuthToken(value: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, value);
}

export function getAuthToken(): string {
  return token();
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function tokenQuery(): string {
  return encodeURIComponent(token());
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorText(status: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as { error?: unknown; message?: unknown };
    if (typeof record.error === "string" && record.error.trim()) return record.error;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  }
  if (typeof payload === "string" && payload.trim()) return payload;
  return `Request failed with status ${status}`;
}

export async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  const authToken = token();

  if (authToken) {
    headers.set("authorization", `Bearer ${authToken}`);
  }
  if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(apiUrl(path), { ...options, headers });
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent("auth:invalid"));
  }
  return response;
}

export async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await authFetch(path, options);
  const payload = await responsePayload(response);

  if (!response.ok) {
    throw new ApiRequestError(response.status, errorText(response.status, payload), payload);
  }
  return payload as T;
}

export async function uploadJson<T>(path: string, body: FormData): Promise<T> {
  return requestJson<T>(path, { method: "POST", body });
}
