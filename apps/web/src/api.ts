/**
 * Everything this application knows how to ask the server.
 *
 * It never holds a token. Signing in exchanges one for an httpOnly cookie the browser attaches
 * on its own, so a token is never in `localStorage` where any injected script could read it —
 * and the corpus is full of attacker-controllable text, which is the whole reason §10 Layer 5
 * exists. `credentials: 'same-origin'` is what carries the cookie.
 *
 * These endpoints are a thin layer over the ones that already existed. `/app/api/ask` is
 * `/v1/search` with the caller resolved from the cookie instead of a bearer header; the admin
 * ones are the `/v1/admin/*` endpoints. Nothing here re-implements a rule that lives in the API.
 */

export interface ScopeChoice {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ScopeGroup {
  label: string | null;
  options: ScopeChoice[];
}

export interface Citation {
  marker: number;
  chunkId: string;
  repo: string | null;
  qualifiedName: string | null;
  path: string | null;
  startLine: number | null;
  analysisDepth: string;
}

export interface Answer {
  text: string;
  citations: Citation[];
  abstained: boolean;
}

export interface Repo {
  id: string;
  name: string;
  remote: string;
  modules: number;
  symbols: number;
  documents: number;
}

export interface Person {
  id: string;
  subject: string;
  displayName: string | null;
  clearance: string;
  roles: string[];
  repositories: number;
}

export interface Me {
  subject: string;
  isAdmin: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/app/api${path}`, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : {},
    ...init,
  });

  if (!response.ok) {
    // The server's own message where there is one — it says more than a status code, and it is
    // the message the API decided was safe to show.
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError(
      body.error?.message ?? `Request failed (${response.status})`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export const api = {
  me: () => call<Me>('/me'),
  signIn: (token: string) =>
    call<Me>('/login', { method: 'POST', body: JSON.stringify({ token }) }),
  signOut: () => call<{ ok: true }>('/logout', { method: 'POST' }),

  scope: () => call<{ groups: ScopeGroup[] }>('/scope'),

  ask: (input: {
    question: string;
    scope: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    everywhere: boolean;
  }) => call<{ answer: Answer }>('/ask', { method: 'POST', body: JSON.stringify(input) }),

  repos: () => call<{ repos: Repo[] }>('/repos'),
  addRepo: (input: { remote: string; projectSlugs: string[] }) =>
    call<{ repoId: string; unknownProjectSlugs: string[] }>('/repos', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  credential: (repoId: string, reason: string) =>
    call<{ token: string; expiresAt: string }>(`/repos/${encodeURIComponent(repoId)}/credential`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  reindex: (repoId: string, reason: string) =>
    call<{ queued: number }>('/reindex', {
      method: 'POST',
      body: JSON.stringify({ repoId, reason }),
    }),

  people: () => call<{ people: Person[] }>('/people'),
  addPerson: (input: {
    subject: string;
    displayName: string | null;
    clearance: string;
    admin: boolean;
    repoIds: string[];
    reason: string;
  }) =>
    call<{ subject: string; token: string; grantedRepoIds: string[] }>('/people', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
