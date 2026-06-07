export function isSupabaseSecretApiKey(key: string | null | undefined) {
  return Boolean(key?.trim().startsWith("sb_secret_"));
}

export function createSupabaseSecretKeyFetch(key: string): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") === `Bearer ${key}`) {
      headers.delete("authorization");
    }
    return fetch(input, { ...init, headers });
  };
}
