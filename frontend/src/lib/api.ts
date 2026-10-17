import { useAuthStore } from '@/store/auth';

// In the desktop app the API serves these pages itself, so everything is same-origin.
const DESKTOP = process.env.NEXT_PUBLIC_DESKTOP === '1';

export const API_URL = DESKTOP ? '' : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');

/** Resolved at connect time because the desktop build only knows its origin in the browser. */
export function webSocketUrl(): string {
  if (!DESKTOP) return process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * JSON request against the backend with the session token attached.
 * A 401 on an authenticated call means the session is gone, so it logs out;
 * the auth gate then sends the user to the login page.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { token } = useAuthStore.getState();
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the trading server. Check that the API is running.');
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && token) useAuthStore.getState().logout();
    throw new ApiError(response.status, payload?.error?.code ?? 'ERROR', payload?.error?.message ?? `Request failed (${response.status})`);
  }
  return payload as T;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');
