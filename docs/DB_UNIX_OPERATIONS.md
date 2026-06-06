# Database and Unix Operations

## Purpose

Adfinem supports Action Library-driven database and Unix batch steps inside the same scenario engine as API operations.

Scenarios do not carry arbitrary SQL or shell commands. They reference allowlisted Action Library templates:

- `catalogs/queries.yaml`
- `catalogs/batches.yaml`

This keeps generated or hand-authored scenarios executable but bounded.

## Database Queries

Use `db_assert` when the query has an `expect` block and must pass or fail the scenario.

```yaml
- id: assert_activity
  action: db_assert
  via: db
  query: test_activity_exists
  params:
    case_id: "${case_id}"
    amount: 100.00
```

Use `db_query` when the query is meant to retrieve values for later steps.

```yaml
- id: load_case
  action: db_query
  via: db
  query: case_by_external_id
  params:
    external_id: "CASE-1001"
```

Direct CLI checks:

```powershell
npm run adfinem -- db-query test_activity_exists --env local --params "{\"case_id\":\"CASE-1001\",\"amount\":111}"
npm run adfinem -- db-assert test_activity_exists --env local --params "{\"case_id\":\"CASE-1001\",\"amount\":111}"
```

## Unix Batches

Batch templates define the SSH host, command, arguments, timeout, success criteria, and optional captures.

```yaml
daily_processing:
  hostRef: qa_worker
  command: "run_daily_processing.sh"
  args:
    - name: processing_date
      required: true
      pattern: "^\\d{4}-\\d{2}-\\d{2}$"
  timeoutSeconds: 3600
  success:
    exitCodes: [0]
    requiredOutput:
      - "SUCCESS"
  captures:
    daily_processing_exit_code: "$.exitCode"
```

Scenario step:

```yaml
- id: run_processing
  action: unix_batch
  via: unix
  batch: daily_processing
  params:
    processing_date: "${processing_date}"
  retry:
    attempts: 2
    delaySeconds: 30
```

Direct CLI check:

```powershell
npm run adfinem -- run-batch daily_processing --env local --params "{\"processing_date\":\"2026-04-27\"}" --attempts 2 --delay-seconds 30
```

## Captures

Database and Unix steps can capture values into scenario context. Later steps can use them as `${name}`.

Supported capture expressions:

- JSONPath: `$.rows[0].CNT`, `$.stdout`, `$.exitCode`
- Simple property path: `rowCount`, `stdout`, `exitCode`
- Literal: `literal:some-value`
- Regex: `regex:$.stdout:Case=(\\d+)`

If a capture expression does not match, the step fails. This is intentional so data passing bugs are visible.

## Environment

`config/environments.yaml` maps environment names to database and SSH connection settings. Values usually come from `.env`:

```text
ADFINEM_DB_USER=
ADFINEM_DB_PASSWORD=
ADFINEM_DB_CONNECT_STRING=
ADFINEM_SSH_QA_WORKER_HOST=
ADFINEM_SSH_USER=
ADFINEM_SSH_PASSWORD=
ADFINEM_SSH_PRIVATE_KEY_PATH=
```

## Evidence

Each database step writes `<step>.db.json`.

Each Unix step writes `<step>.unix.json`, and when captures exist, `<step>.unix-captures.json`.
