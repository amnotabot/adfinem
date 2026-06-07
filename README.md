# Adfinem

Open-source QA test helper for deterministic API, database, Unix batch, and workflow automation.

Adfinem executes catalog-gated workflows only. Scenario YAML can reference:

- `catalogs/api-operations.yaml`
- `catalogs/queries.yaml`
- `catalogs/batches.yaml`

## Install

```bash
npm install
npm run check
```

When published to npm, the CLI can also be installed globally:

```bash
npm install -g adfinem
adfinem validate scenarios/smoke/account-processing-smoke.yaml
```

## Commands

```bash
npm install
npm test
npm run build
npm run validate
npm run smoke:dry
npm run adfinem -- run scenarios/smoke/account-processing-smoke.yaml --env local --dry-run
npm run adfinem -- api-call create_test_case --env local --param tenant=demo --param external_id=CASE-1001 --param case_type=account-processing
npm run adfinem -- db-query test_activity_exists --env local --param case_id=CASE-1001 --param amount=json:111
npm run adfinem -- run-batch daily_processing --env local --param processing_date=2026-04-27
```

Use `--dry-run` while catalogs and environment credentials are still being completed.

See `docs/FLOW_BUILDER.md` for flow files and `docs/DB_UNIX_OPERATIONS.md` for database and Unix scenario steps.

## Package Safety

The npm package is allowlisted through `package.json#files` so local state such as `.env`, evidence, logs, dependencies, and uploaded batch input files are not included in published artifacts.

Before publishing or opening a release PR, run:

```bash
npm run check
npm run package:dry-run
```

## License

MIT
