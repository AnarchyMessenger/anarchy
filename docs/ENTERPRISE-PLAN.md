# Anarchy Company edition: enterprise plan

The first product. It replaces Microsoft Teams and OneDrive (or Slack and Google Drive) for organisations that want to leave GAFAM without giving up AI.

## Who buys it

- European SMEs and mid-market companies (50–5,000 seats) under sovereignty pressure: public sector suppliers, healthcare, legal, finance, defence supply chain.
- Public bodies and universities with "no US cloud" mandates.
- Privacy-first tech companies that want AI on their own infrastructure.

## Value proposition

1. **One app** for chat, voice and video channels, files, and guest access, instead of Teams + OneDrive + SharePoint.
2. **End-to-end encryption by default**, with the AI brought in only as a visible, removable member (the Company Brain).
3. **The AI works for the company, not the vendor.** The Company MCP gives any agent or harness permission-checked access to company context, running on the company's own models.
4. **Self-hosted or EU-hosted.** No dependency on Microsoft, Google, Amazon or Apple, except mobile push wakes, which carry no content.

## Editions

| | Team | Business | Enterprise |
|---|---|---|---|
| Target | < 50 seats | 50–1,000 | 1,000+ / regulated |
| Hosting | Our EU cloud | EU cloud or self-hosted | Self-hosted, private cloud or air-gapped |
| Chat, voice channels, calls | ✓ | ✓ | ✓ |
| Drive storage | 100 GB pooled | 1 TB + per seat | Custom / own S3 |
| Temporary invites and guests | ✓ | ✓ + approval policies | ✓ + guest domains, auto-expiry audit |
| Portal | — | ✓ | ✓ + custom apps and tiles |
| Company Brain + MCP | Hosted (confidential VM) | Hosted or self-hosted | Self-hosted, own models |
| SSO (OIDC) | ✓ | ✓ | ✓ |
| SCIM, retention, legal hold | — | ✓ | ✓ |
| Key recovery escrow | Off | Optional | Optional, threshold admins |
| IRC gateway | — | ✓ | ✓ |
| Support | Community | Business hours | 24/7, SLA, named contact |

Pricing is to be validated. Anchor below Microsoft 365 Business Standard per seat and charge for the Brain as an add-on, since model compute is the main variable cost.

## Enterprise requirements checklist

- **Identity:** OIDC SSO (Entra ID, Keycloak, Authentik, Okta), SCIM provisioning and deprovisioning. Deprovisioning removes the user's devices from every MLS group.
- **Compliance:** GDPR (DPA, subprocessors, data residency), NIS2 support, a SOC 2 Type II / ISO 27001 roadmap, and data held in the EU only.
- **Retention and eDiscovery:** retention policies per channel class. Legal hold and export cover **Company-state channels only**. Sealed channels are exportable only by their members. This trade-off is stated in sales material, never hidden.
- **Audit:** admin actions, invite lifecycle, access decisions and every Company MCP query.
- **Security:** a published threat model, an independent crypto audit before GA, a bug bounty, reproducible builds.
- **Migration:** importers for Slack exports, Teams via Graph export, and OneDrive or Google Drive folders.
- **Deployment:** Helm chart, docker compose for small installs, air-gapped bundle, S3 storage the customer brings.

## Go-to-market

1. **Design partners:** 3–5 EU organisations on free Business licences in exchange for weekly feedback, starting at ROADMAP phase 1.
2. **Open core:** server and clients open source (license to be decided; AGPL for the server protects against cloud resale). Enterprise features (SCIM, legal hold, escrow, the hosted Brain) are commercial.
3. **Channels:** EU cloud providers (OVH, Scaleway, Hetzner marketplaces) and sovereignty-focused integrators.

## Main risks

- **Trust:** a new crypto product has to earn trust with an external audit before any regulated customer signs.
- **Brain leakage:** one permission leak in an AI answer can lose the account. ACL-filtered retrieval gets a red-team test every release.
- **Feature parity expectations:** Teams bundles Office. We integrate with office suites the customer already has (Collabora Online, OnlyOffice) through the drive rather than building one.
- **Scope creep:** the Community edition waits. See ROADMAP.md.
