# Self-hosting the Anarchy server

> Phase 0: for evaluation only. See the "Not safe yet" list at the end.

## Requirements

- PostgreSQL 14 or later (16 recommended). The server creates its tables on start.
- An OpenID Connect identity provider your organisation already uses: Keycloak, Authentik, Zitadel, Entra ID, Google Workspace, Okta.
- A TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of the server.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/anarchy` |
| `ANARCHY_OIDC_ISSUER` | yes | Your provider's issuer URL, exactly as it appears in ID tokens (e.g. `https://sso.example.org/realms/anarchy`) |
| `ANARCHY_OIDC_AUDIENCE` | yes | The client ID you registered for Anarchy (e.g. `anarchy-desktop`) |
| `ANARCHY_OIDC_JWKS_URL` | no | Signing keys URL. When unset, discovered from `{issuer}/.well-known/openid-configuration` |
| `ANARCHY_ORG_NAME` | yes | Your organisation's name. One server hosts one organisation. |
| `ANARCHY_LISTEN` | no | Default `127.0.0.1:8080` |
| `ANARCHY_SESSION_TTL_SECS` | no | Session lifetime, default 30 days |

Register Anarchy in your identity provider as a **public client** using the authorization code flow with PKCE. The desktop app signs in through the system browser and sends the ID token to `POST /v1/auth/oidc`. Accepted signing algorithms: RS256, PS256, ES256, ES384, EdDSA.

## What the server stores

Users (issuer, subject, name, email), hashed session tokens, device public keys, channel membership, and **encrypted** message payloads. It never stores message plaintext or private keys. The Company Brain, if you run it, has its own database, which does hold plaintext of the channels it was added to. Run it on infrastructure you control.

## Not safe yet (phase 0)

- The desktop app doesn't yet run the browser sign-in flow; only the API and tests do.
- Devices aren't asked to prove they hold their private key when registering.
- Any channel member can remove any other member; channel roles come later.
- The Brain's device key (32 bytes) must be supplied by you from a secret store; there is no Brain binary yet, only the library.
