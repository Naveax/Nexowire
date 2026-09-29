import { createHash, timingSafeEqual } from 'node:crypto';

export function parseTokenList(
  ...values: Array<string | undefined>
): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const value of values) {
    for (const part of value?.split(',') ?? []) {
      const token = part.trim();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }

  return tokens;
}

export function bearerFromHeader(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token || undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function matchesAnyToken(
  candidate: string | undefined,
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return false;

  const candidateDigest = digest(candidate ?? '');
  let matched = 0;

  for (const token of tokens) {
    const tokenDigest = digest(token);
    if (timingSafeEqual(candidateDigest, tokenDigest)) {
      matched |= 1;
    }
  }

  return matched === 1;
}

export function matchesBearerHeader(
  header: string | undefined,
  tokens: readonly string[],
): boolean {
  return matchesAnyToken(bearerFromHeader(header), tokens);
}
