# Adfinem

Open-source end-to-end QA test helper for deterministic API, database, Unix batch, and workflow automation.

Adfinem is built for testers working on enterprise-grade business solutions where repeatable, catalog-gated checks matter.

Adfinem executes catalog-gated workflows only. Scenario YAML can reference:

- `catalogs/api-operations.yaml`
- `catalogs/queries.yaml`
- `catalogs/batches.yaml`

## What It Does

Adfinem lets QA teams define repeatable end-to-end checks that combine:

- REST API calls from an allowlisted operation catalog
- database queries, assertions, and execution steps
- Unix commands over SSH, including batch operations and file-backed processing
- SFTP file placement before Unix jobs and output retrieval after they finish
- workflow files that chain API, DB, Unix, loop, parallel, and reusable flow blocks
- dry-run validation before touching external systems
- evidence output for executed runs

## Install

```bash
npm install
npm run check
```

The published CLI can also be installed globally:

```bash
npm install -g adfinem
adfinem init my-adfinem-tests
cd my-adfinem-tests
adfinem validate scenarios/smoke/account-processing-smoke.yaml
adfinem app
```

## Commands

```bash
npm install
npm test
npm run build
npm run validate
npm run smoke:dry
```

## CLI-Only Usage

Adfinem can be used fully from the terminal when a GUI is not wanted.

```bash
# Create a starter project when using the global package
adfinem init my-adfinem-tests
cd my-adfinem-tests

# Open the web workbench for the current project
adfinem app

# Validate a scenario before running it
adfinem validate scenarios/smoke/account-processing-smoke.yaml

# Run a scenario without external side effects
adfinem run scenarios/smoke/account-processing-smoke.yaml --env local --dry-run

# Execute a cataloged API operation
adfinem api-call create_test_case --env local --param tenant=demo --param external_id=CASE-1001 --param case_type=account-processing

# Execute a cataloged DB query
adfinem db-query test_activity_exists --env local --param case_id=CASE-1001 --param amount=json:111

# Run a cataloged Unix batch
adfinem run-batch daily_processing --env local --param processing_date=2026-04-27
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
