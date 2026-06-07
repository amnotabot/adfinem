# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately through GitHub security advisories when available, or by contacting the repository owner directly.

Do not include secrets, credentials, private endpoints, raw production payloads, or proprietary SQL in public issues.

## Sensitive Data

Adfinem is designed around catalog-gated actions, but users are still responsible for keeping local environment files, evidence, logs, and batch input files out of published artifacts.

The repository `.gitignore` excludes common local-state paths such as `.env`, `evidence/`, `web-dist/`, and uploaded batch input files.
