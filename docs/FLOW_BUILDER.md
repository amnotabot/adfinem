# Flow Builder

## Purpose

Flows are the durable source of truth for chained API, database, and Unix automation. They let you combine cataloged API operations with database queries, assertions, Unix batches, and captured output mappings without typing long CLI command chains.

Flow files live under `flows/` and use the suffix `.flow.yaml`.

## Concepts

- **API operation**: an allowlisted operation from `catalogs/api-operations.yaml`.
- **Action**: a technical step such as `db_query`, `db_assert`, `db_execute`, or `unix_batch`.
- **Post action**: an action attached to an API operation and executed immediately after it.
- **Output mapping**: later steps reference previous outputs with `${node_id.capture_name}`.

The compatibility folder is still named `catalogs/`; those files are the Action Library.

## CLI

Validate a flow:

```powershell
npm run adfinem -- validate-flow flows\account_processing_cycle.flow.yaml
```

Compile a flow to the scenario structure:

```powershell
npm run adfinem -- compile-flow flows\account_processing_cycle.flow.yaml --output evidence\compiled-flow.json
```

Dry run a flow:

```powershell
npm run adfinem -- run-flow flows\account_processing_cycle.flow.yaml --env local --dry-run
```

Execute a flow:

```powershell
npm run adfinem -- run-flow flows\account_processing_cycle.flow.yaml --env local
```

Create a new flow by concatenating existing flows:

```powershell
npm run adfinem -- concat-flows flows\combined.flow.yaml flows\first.flow.yaml flows\second.flow.yaml --id combined --name "Combined flow"
```

The concat command preserves the internal order of each input flow, connects the last top-level node of one flow to the first top-level node of the next flow, merges variables, and rewrites node references if ids collide.

## Local App

Start the app:

```powershell
npm run app
```

Open:

```text
http://localhost:4177
```

The app saves the same flow files used by the CLI. It can load API operations, database templates, Unix batches, validate flows, and start runs through the local backend.

### Workbench Features

- Delete saved workflows from the Flows explorer. The app removes the matching `flows/*.flow.yaml` file after confirmation.
- Import Postman collection JSON files from **API Collections**. Imported collections are stored locally in `catalogs/api-collections.json` and exposed as grouped request templates instead of flooding the sidebar.
- Click an imported collection to search requests by folder, method, name, or path, then add one or multiple requests to the workflow.
- API request steps are editable per workflow. Method, path, headers, query params, body, auth, inputs, captures, assertions, and accepted statuses can diverge from the imported template without changing the source collection.
- Import Postman environment JSON files from the top bar. Variables are copied into the selected workflow/environment input set.
- Use insert controls, drag/drop, move, duplicate, disable, and section labels to organize the workflow timeline.
- Recent run history is read from `evidence/*/run-result.json` and shown per workflow.

## Evidence

Each `run-flow` execution writes:

- `run-result.json`
- the original `flow.yaml`
- `compiled-flow.json`
- per-step input/evidence files
- `report.html`
- `junit.xml`
