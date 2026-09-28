# Self-hosting the Anarchy server

> Phase 0: for evaluation only. See the "Not safe yet" list at the end.

## Requirements

- PostgreSQL 14 or later (16 recommended). The server creates its tables on start.
- At least one way to sign in:
  - an OpenID Connect identity provider your organisation already uses (Keycloak, Authentik, Zitadel, Entra ID, Google Workspace, Okta), and/or
  - an SMTP server, for emailed one-time codes to addresses on your domains.
- A TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of the server.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/anarchy` |
| `ANARCHY_OIDC_ISSUER` | for SSO | Your provider's issuer URL, exactly as it appears in ID tokens (e.g. `https://sso.example.org/realms/anarchy`) |
| `ANARCHY_OIDC_AUDIENCE` | with the issuer | The client ID you registered for Anarchy (e.g. `anarchy-desktop`) |
| `ANARCHY_OIDC_JWKS_URL` | no | Signing keys URL. When unset, discovered from `{issuer}/.well-known/openid-configuration` |
| `ANARCHY_ORG_NAME` | yes | Your organisation's name. One server hosts one organisation. |
| `ANARCHY_LISTEN` | no | Default `127.0.0.1:8080` |
| `ANARCHY_SESSION_TTL_SECS` | no | Session lifetime, default 30 days |
| `ANARCHY_EMAIL_DOMAINS` | for email codes | Comma-separated domains allowed to sign in with an emailed code, e.g. `northwind.org,northwind.eu`. Anyone who can read mail at one of these domains can sign in, so list only domains you control. |
| `ANARCHY_SMTP_URL` | with email domains | e.g. `smtps://user:pass@smtp.example.org:465` or `smtp://…:587?tls=required` |
| `ANARCHY_EMAIL_FROM` | with email domains | Sender, e.g. `Anarchy <no-reply@northwind.org>` |
| `ANARCHY_EMAIL_DEV_LOG` | no | `1` prints codes to the server log instead of sending mail. Development only; never in production. |
| `ANARCHY_GUESTS_ENABLED` | no | `true` lets members invite guests (no account; access ends with the invite). Off by default. |

The server refuses to start unless SSO or email codes is configured. Email codes are 6 digits, valid for 10 minutes, 5 tries each, and at most 20 failed tries per address per day.

For SSO, register Anarchy in your identity provider as a **public client** using the authorization code flow with PKCE, and allow the loopback redirect `http://127.0.0.1/callback` on any port (RFC 8252; in Keycloak, add `http://127.0.0.1/*` as a valid redirect URI). The desktop app signs in through the system browser and sends the ID token to `POST /v1/auth/oidc`. Accepted signing algorithms: RS256, PS256, ES256, ES384, EdDSA.

## What the server stores

Users (issuer, subject, name, email), hashed session tokens, device public keys, channel membership, and **encrypted** message payloads. It never stores message plaintext or private keys. The Company Brain, if you run it, has its own database, which does hold plaintext of the channels it was added to. Run it on infrastructure you control.

## Not safe yet (phase 0)

- Rate limits on email codes are per address only; nothing yet limits one IP trying many addresses. Put the server behind a proxy with request limits.
- Messages arrive by polling every few seconds; live push (WebSocket) comes later.
- Devices aren't asked to prove they hold their private key when registering.
- Any channel member can remove any other member; channel roles come later.
- The Brain's device key (32 bytes) must be supplied by you from a secret store; there is no Brain binary yet, only the library.
