/**
 * OAuth 2.1 token validation for the MCP Resource Server.
 *
 * The remote MCP server is an OAuth Resource Server (MCP auth spec, rev
 * 2025-11-25); Auth0 is the Authorization Server. A Claude client that went
 * through the OAuth flow sends an Auth0-issued JWT access token. We verify it
 * against Auth0's JWKS and, crucially, check the token `aud` matches THIS server
 * (RFC 8707 resource-indicator binding) so a token minted for something else is
 * rejected.
 *
 * OAuth is active only when BOTH AUTH0_ISSUER and MCP_AUDIENCE are configured.
 * Until then the server behaves exactly as before (Bearer header = raw API key),
 * so the code can ship ahead of the Auth0 tenant setup.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OAuthConfig {
  issuer: string;
  audience: string;
}

export function oauthConfig(): OAuthConfig | null {
  const issuer = process.env.AUTH0_ISSUER;
  const audience = process.env.MCP_AUDIENCE;
  return issuer && audience ? { issuer, audience } : null;
}

// One JWKS set per warm lambda; keyed by issuer so a config change re-fetches.
let cachedIssuer: string | null = null;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function jwksFor(issuer: string) {
  if (!cachedJwks || cachedIssuer !== issuer) {
    const base = issuer.replace(/\/+$/, "");
    cachedJwks = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
    cachedIssuer = issuer;
  }
  return cachedJwks;
}

/** A raw ScrapeUnblocker key is a single opaque string; a JWT has three
 * dot-separated segments. This lets the Bearer header carry either. */
export function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

export interface VerifiedToken {
  sub?: string;
  email?: string;
}

/**
 * Verify an Auth0 access token and pull the user's email. Returns null on any
 * failure (bad signature, wrong issuer/audience, expired, no OAuth configured).
 * The email comes from a namespaced custom claim (MCP_EMAIL_CLAIM, set by an
 * Auth0 Post-Login Action) or the standard `email` claim.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedToken | null> {
  const cfg = oauthConfig();
  if (!cfg) return null;
  try {
    const { payload } = await jwtVerify(token, jwksFor(cfg.issuer), {
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
    const claim = process.env.MCP_EMAIL_CLAIM;
    const fromClaim =
      claim && typeof payload[claim] === "string" ? (payload[claim] as string) : undefined;
    const email = fromClaim || (typeof payload.email === "string" ? payload.email : undefined);
    return {
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      email,
    };
  } catch {
    return null;
  }
}

/** RFC 6750 WWW-Authenticate value pointing Claude at our protected-resource
 * metadata so it can discover the Authorization Server. */
export function wwwAuthenticate(resourceMetadataUrl: string, error?: string): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`];
  if (error) parts.push(`error="${error}"`);
  parts.push(`scope="mcp:use"`);
  return parts.join(", ");
}
