export interface GitHubManifestCredentials {
  clientId: string;
  clientSecret: string;
  appId: number;
  slug: string;
}

function secureOrigin(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'GitHub App manifest origin must be a clean HTTPS origin.',
    );
  }
  return url.origin;
}

export function buildGitHubAppManifest(input: {
  origin: string;
  suggestedName: string;
}): Record<string, unknown> {
  const origin = secureOrigin(input.origin);
  const name = input.suggestedName.trim();
  if (!name || name.length > 100) {
    throw new Error(
      'GitHub App manifest name must be 1-100 characters.',
    );
  }

  return {
    name,
    url: origin,
    redirect_url:
      origin + '/setup/github/callback',
    callback_urls: [
      origin + '/auth/github/callback',
    ],
    description:
      'Nexowire account sign-in and device control-plane identity.',
    public: true,
    default_permissions: {},
    default_events: [],
    request_oauth_on_install: false,
  };
}

export async function exchangeGitHubAppManifestCode(
  codeInput: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubManifestCredentials> {
  const code = codeInput.trim();
  if (
    !/^[A-Za-z0-9_-]{8,256}$/.test(code)
  ) {
    throw new Error(
      'GitHub App manifest code is invalid.',
    );
  }

  const response = await fetchImpl(
    'https://api.github.com/app-manifests/' +
      encodeURIComponent(code) +
      '/conversions',
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent':
          'Nexowire-Control-Plane-Setup',
        'x-github-api-version': '2026-03-10',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      'GitHub App manifest conversion failed.',
    );
  }

  const body = await response.json() as {
    id?: unknown;
    slug?: unknown;
    client_id?: unknown;
    client_secret?: unknown;
  };
  if (
    !Number.isInteger(body.id) ||
    typeof body.slug !== 'string' ||
    !body.slug ||
    typeof body.client_id !== 'string' ||
    !body.client_id ||
    typeof body.client_secret !== 'string' ||
    !body.client_secret
  ) {
    throw new Error(
      'GitHub App manifest conversion response is invalid.',
    );
  }

  return {
    appId: body.id as number,
    slug: body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
  };
}
