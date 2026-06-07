# Contributing

Thanks for helping improve Adfinem.

## Local Setup

```bash
npm install
npm run check
npm run validate
npm run smoke:dry
```

Use dry runs while changing catalog or environment configuration.

## Development Notes

- Keep scenarios catalog-gated; do not add arbitrary SQL, shell, or request bodies directly to scenario files when a catalog entry is the safer fit.
- Do not commit `.env`, evidence folders, uploaded batch input files, or local logs.
- Add or update tests when changing compiler, runner, adapter, or validation behavior.
- Run `npm run package:dry-run` before proposing publication-related changes.

## Pull Requests

Please include:

- A short summary of the change.
- The commands you ran.
- Any migration notes for catalogs, scenarios, or flows.
