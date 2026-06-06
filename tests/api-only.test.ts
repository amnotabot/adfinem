import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Catalogs } from "../src/dsl/types.js";
import { validateScenarioReferences } from "../src/dsl/validator.js";
import { importedOperationsFromCollections, mergeApiRequest, parsePostmanCollection } from "../src/adapters/api/api-collections.js";
import { requestPathForBase, RestClient, withGeneratedHeaders } from "../src/adapters/api/rest-client.js";
import { assertApiResponse } from "../src/adapters/api/rest-client.js";
import { normalizeBindParamRecord, validateQueryParams } from "../src/adapters/db/query-catalog.js";
import { buildBatchCommand, buildBatchDisplayCommand } from "../src/adapters/unix/batch-catalog.js";
import { BatchRunner } from "../src/adapters/unix/batch-runner.js";
import { buildSshExecCommand } from "../src/adapters/unix/ssh-client.js";
import { applyEvidenceVisibility } from "../src/config/secrets.js";
import { RunContext } from "../src/engine/context.js";
import { ScenarioRunner } from "../src/engine/runner.js";
import { normalizeFlowCatalogParams } from "../src/flows/catalog-normalizer.js";
import { compileFlow } from "../src/flows/compiler.js";
import { flowToYaml } from "../src/flows/parser.js";
import { validateFlow } from "../src/flows/validator.js";
import type { FlowFile } from "../src/flows/types.js";

const catalogs: Catalogs = {
  apiOperations: {
    board_financial_account: {
      type: "rest",
      method: "POST",
      path: "/boarding",
      captures: {
        account_number: "$.account.accountNumber"
      }
    }
  },
  queries: {
    test_activity_exists: {
      sql: "select 1 as CNT from dual where ACCOUNT_NUMBER = :account_number",
      params: {
        account_number: { required: true }
      },
      captures: {
        adjustment_count: "$.rows[0].CNT"
      }
    }
  },
  batches: {
    daily_processing: {
      hostRef: "qa_worker",
      command: "run_daily_processing.sh",
      args: [
        { name: "business_date", required: true }
      ]
    }
  }
};

describe("API-only workflow model", () => {
  it("compiles API operation flow nodes to API scenario steps", async () => {
    const flow: FlowFile = {
      version: 1,
      id: "api_flow",
      environment: "local",
      nodes: [
        {
          id: "board_account",
          type: "api_operation",
          operation: "board_financial_account",
          input: {
            bank: "000001"
          },
          postActions: [
            {
              id: "check_adjustment",
              type: "db_query",
              query: "test_activity_exists",
              params: {
                account_number: "${board_account.account_number}"
              }
            }
          ]
        }
      ]
    };

    const validation = await validateFlow(flow, catalogs, process.cwd());
    assert.equal(validation.ok, true, validation.errors.join("\n"));

    const compiled = compileFlow(flow);
    assert.deepEqual(compiled.scenario.steps.map((step) => ({ id: step.id, action: step.action, via: step.via })), [
      { id: "board_account", action: "board_financial_account", via: "api" },
      { id: "check_adjustment", action: "db_query", via: "db" }
    ]);
  });

  it("normalizes DB bind parameter names without leading colon", () => {
    const dbCatalogs: Catalogs = {
      ...catalogs,
      queries: {
        case_by_external_id: {
          sql: "select account_number from test_case_link where external_id = :caseId",
          params: {
            ":caseId": { required: true, type: "string" }
          }
        }
      }
    };
    const flow: FlowFile = {
      version: 1,
      id: "db_bind_flow",
      environment: "local",
      nodes: [
        {
          id: "lookup",
          type: "db_query",
          query: "case_by_external_id",
          params: {
            ":caseId": "${create_case.caseId}"
          }
        }
      ]
    };

    validateQueryParams(dbCatalogs.queries.case_by_external_id, { ":caseId": "4537850208919276" });
    assert.deepEqual(normalizeBindParamRecord({ ":caseId": "4537850208919276" }), { caseId: "4537850208919276" });
    assert.deepEqual(normalizeFlowCatalogParams(flow, dbCatalogs).nodes[0].params, { caseId: "${create_case.caseId}" });
  });

  it("does not force omitted Unix batch args into workflow steps", async () => {
    const flow: FlowFile = {
      version: 1,
      id: "batch_flow",
      environment: "local",
      nodes: [
        {
          id: "eod",
          type: "unix_batch",
          batch: "daily_processing",
          params: {}
        }
      ]
    };

    const normalized = normalizeFlowCatalogParams(flow, catalogs);
    assert.deepEqual(normalized.nodes[0].params, {});
    const validation = await validateFlow(normalized, catalogs, process.cwd());
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    assert.equal(buildBatchCommand(catalogs.batches.daily_processing, {}), "'run_daily_processing.sh'");
  });

  it("does not prepend Unix batch working directory unless explicitly enabled", () => {
    const entry = {
      hostRef: "qa_worker",
      workingDirectory: "/srv/adfinem/bin",
      command: "sh",
      fixedArgs: ["-x", "reconcile_nightly.sh", "reconcile_nightly.log", "DEMO"]
    };

    assert.equal(
      buildBatchCommand(entry, {}),
      "'sh' '-x' 'reconcile_nightly.sh' 'reconcile_nightly.log' 'DEMO'"
    );
    assert.equal(
      buildBatchDisplayCommand(entry, {}),
      "sh -x reconcile_nightly.sh reconcile_nightly.log DEMO"
    );
    assert.equal(
      buildBatchCommand({ ...entry, useWorkingDirectory: true }, {}),
      "cd '/srv/adfinem/bin' && 'sh' '-x' 'reconcile_nightly.sh' 'reconcile_nightly.log' 'DEMO'"
    );
    assert.equal(
      buildBatchDisplayCommand({ ...entry, useWorkingDirectory: true }, {}),
      "cd /srv/adfinem/bin && sh -x reconcile_nightly.sh reconcile_nightly.log DEMO"
    );
  });

  it("can run Unix batch commands through a login shell for profile PATH resolution", () => {
    const command = buildBatchCommand(catalogs.batches.daily_processing, {});
    assert.equal(buildSshExecCommand({ loginShell: false }, command), command);
    const wrapped = buildSshExecCommand({ shell: "bash", loginShell: true }, command);
    assert.match(wrapped, /^'bash' -lc /);
    assert.match(wrapped, /run_daily_processing\.sh/);
  });

  it("treats configured batch exit code 1 as success and 99 as failure", async () => {
    const entry = {
      hostRef: "qa_worker",
      command: "reconcile_nightly.sh",
      success: { exitCodes: [0, 1] }
    };
    const successRunner = new BatchRunner({
      execute: async () => ({ stdout: "FICHIER : /tmp/reconcile_nightly.log\nERRNO :2", stderr: "", exitCode: 1 })
    } as any);
    const failedRunner = new BatchRunner({
      execute: async () => ({ stdout: "", stderr: "batch failure", exitCode: 99 })
    } as any);

    const success = await successRunner.run(entry, {});
    const failure = await failedRunner.run(entry, {});

    assert.equal(success.status, "passed");
    assert.equal(success.exitCode, 1);
    assert.equal(success.displayCommand, "reconcile_nightly.sh");
    assert.equal(success.tracePath, "/tmp/reconcile_nightly.log");
    assert.equal(success.errno, "2");
    assert.equal(failure.status, "failed");
    assert.equal(failure.exitCode, 99);
  });

  it("uploads Unix batch input files over SFTP and injects the remote path as an arg", async () => {
    const uploads: Array<{ hostRef: string; remotePath: string; content: string }> = [];
    const commands: string[] = [];
    const runner = new BatchRunner({
      uploadFile: async (hostRef: string, remotePath: string, content: Buffer) => {
        uploads.push({ hostRef, remotePath, content: content.toString("utf8") });
      },
      execute: async (_hostRef: string, command: string) => {
        commands.push(command);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    } as any);
    const entry = {
      hostRef: "qa_worker",
      command: "process_input.sh",
      args: [{ name: "input_path", required: true }],
      inputFiles: [{ name: "input_file", remotePath: "/app/input/${fileName}", paramName: "input_path" }]
    };

    const result = await runner.run(entry, {
      input_file: {
        fileName: "transactions.dat",
        contentBase64: Buffer.from("batch file body").toString("base64")
      }
    });

    assert.equal(result.status, "passed");
    assert.deepEqual(uploads, [{ hostRef: "qa_worker", remotePath: "/app/input/transactions.dat", content: "batch file body" }]);
    assert.equal(commands[0], "'process_input.sh' '/app/input/transactions.dat'");
    assert.equal(result.displayCommand, "process_input.sh /app/input/transactions.dat");
    assert.equal(result.fileUploads?.[0]?.status, "uploaded");
    assert.equal(result.fileUploads?.[0]?.paramName, "input_path");
  });

  it("allows uploaded batch file paths to be placed inside fixed args", async () => {
    const commands: string[] = [];
    const runner = new BatchRunner({
      uploadFile: async () => undefined,
      execute: async (_hostRef: string, command: string) => {
        commands.push(command);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    } as any);
    const entry = {
      hostRef: "qa_worker",
      command: "load_file.sh",
      fixedArgs: ["--input", "${remote_input}", "--mode", "LOCAL"],
      inputFiles: [{ name: "input_file", remotePath: "/tmp/${fileName}", paramName: "remote_input" }]
    };

    await runner.run(entry, {
      input_file: {
        fileName: "items.csv",
        contentBase64: Buffer.from("id,status").toString("base64")
      }
    });

    assert.equal(commands[0], "'load_file.sh' '--input' '/tmp/items.csv' '--mode' 'LOCAL'");
  });

  it("treats Unix batch input remote paths ending in slash as deposit directories", async () => {
    const uploads: Array<{ remotePath: string; content: string }> = [];
    const commands: string[] = [];
    const runner = new BatchRunner({
      uploadFile: async (_hostRef: string, remotePath: string, content: Buffer) => {
        uploads.push({ remotePath, content: content.toString("utf8") });
      },
      execute: async (_hostRef: string, command: string) => {
        commands.push(command);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    } as any);

    const result = await runner.run({
      hostRef: "qa_worker",
      command: "import_transactions.sh",
      fixedArgs: ["${incoming_file}"],
      inputFiles: [{ name: "transactions.csv", remotePath: "/srv/adfinem/inbox/", paramName: "incoming_file" }]
    }, {
      "transactions.csv": {
        fileName: "transactions.csv",
        contentBase64: Buffer.from("transaction body").toString("base64")
      }
    });

    assert.equal(result.status, "passed");
    assert.deepEqual(uploads, [{ remotePath: "/srv/adfinem/inbox/transactions.csv", content: "transaction body" }]);
    assert.equal(commands[0], "'import_transactions.sh' '/srv/adfinem/inbox/transactions.csv'");
    assert.equal(result.fileUploads?.[0]?.remotePath, "/srv/adfinem/inbox/transactions.csv");
  });

  it("retrieves generated Unix batch files discovered from stderr into evidence", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "adfinem-batch-output-"));
    try {
      const downloads: string[] = [];
      const runner = new BatchRunner({
        execute: async () => ({ stdout: "", stderr: "FICHIER : /app/out/generated.dat\nERRNO :2", exitCode: 0 }),
        downloadFile: async (_hostRef: string, remotePath: string) => {
          downloads.push(remotePath);
          return Buffer.from("generated body");
        }
      } as any);
      const result = await runner.run({
        hostRef: "qa_worker",
        command: "generate_file.sh",
        outputFiles: [{ name: "statement", source: "stderr", pathPattern: "FICHIER\\s*:\\s*(\\S+)", required: true }]
      }, {}, { downloadDir: tempDir });

      assert.equal(result.status, "passed");
      assert.deepEqual(downloads, ["/app/out/generated.dat"]);
      assert.equal(result.fileDownloads?.[0]?.status, "downloaded");
      assert.equal(result.fileDownloads?.[0]?.remotePath, "/app/out/generated.dat");
      assert.equal(await readFile(result.fileDownloads?.[0]?.localPath ?? "", "utf8"), "generated body");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs configured decrypt commands before downloading generated batch files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "adfinem-batch-decrypt-"));
    try {
      const commands: string[] = [];
      const downloads: string[] = [];
      const runner = new BatchRunner({
        execute: async (_hostRef: string, command: string) => {
          commands.push(command);
          if (command.startsWith("decrypt ")) return { stdout: "decrypted", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "Generated file: /app/out/report.enc", exitCode: 0 };
        },
        downloadFile: async (_hostRef: string, remotePath: string) => {
          downloads.push(remotePath);
          return Buffer.from("plain report");
        }
      } as any);
      const result = await runner.run({
        hostRef: "qa_worker",
        command: "generate_file.sh",
        outputFiles: [{
          name: "report",
          source: "stderr",
          pathPattern: "Generated file:\\s*(\\S+)",
          decrypt: {
            command: "decrypt ${remotePath} ${decryptedRemotePath}",
            outputRemotePath: "${remotePath}.clear"
          }
        }]
      }, {}, { downloadDir: tempDir });

      assert.equal(result.status, "passed");
      assert.equal(commands[1], "decrypt /app/out/report.enc /app/out/report.enc.clear");
      assert.deepEqual(downloads, ["/app/out/report.enc.clear"]);
      assert.equal(result.fileDownloads?.[0]?.decryptedRemotePath, "/app/out/report.enc.clear");
      assert.equal(await readFile(result.fileDownloads?.[0]?.localPath ?? "", "utf8"), "plain report");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates required Unix batch input files separately from plain args", async () => {
    const fileCatalogs: Catalogs = {
      ...catalogs,
      batches: {
        import_batch: {
          hostRef: "qa_worker",
          command: "import_file.sh",
          args: [{ name: "input_path", required: true }],
          inputFiles: [{ name: "input_file", required: true, remotePath: "/tmp/${fileName}", paramName: "input_path" }]
        }
      }
    };
    const missingFile: FlowFile = {
      version: 1,
      id: "file_batch_flow",
      environment: "local",
      nodes: [{ id: "import", type: "unix_batch", batch: "import_batch", params: {} }]
    };
    const withFile: FlowFile = {
      ...missingFile,
      nodes: [{
        id: "import",
        type: "unix_batch",
        batch: "import_batch",
        params: {
          input_file: {
            fileName: "input.txt",
            localPath: "data/batch-input-files/file/import/input/input.txt"
          }
        }
      }]
    };

    const missingValidation = await validateFlow(missingFile, fileCatalogs, process.cwd());
    const validValidation = await validateFlow(withFile, fileCatalogs, process.cwd());

    assert.equal(missingValidation.ok, false);
    assert.match(missingValidation.errors.join("\n"), /missing required batch input file 'input_file'/);
    assert.equal(validValidation.ok, true, validValidation.errors.join("\n"));
  });

  it("accepts cataloged API scenario steps", () => {
    const validation = validateScenarioReferences({
      id: "api_scenario",
      environment: "local",
      steps: [
        {
          id: "board",
          action: "board_financial_account",
          via: "api"
        }
      ]
    }, catalogs);

    assert.equal(validation.ok, true, validation.errors.join("\n"));
  });

  it("parses Postman collections into grouped API operation templates", () => {
    const collection = parsePostmanCollection({
      info: { name: "Example APIs", _postman_id: "example" },
      auth: { type: "bearer", bearer: [{ key: "token", value: "literal-token" }] },
      variable: [{ key: "tenant", value: "001" }],
      item: [
        {
          name: "Adjustments",
          item: [
            {
              name: "Capture adjustment",
              request: {
                method: "POST",
                url: {
                  raw: "{{baseUrl}}/operations/adjustments?tenant={{tenant}}"
                },
                header: [{ key: "X-Trace", value: "{{trace_id}}" }],
                body: {
                  mode: "raw",
                  raw: "{\"amount\":\"{{amount}}\"}"
                }
              }
            }
          ]
        }
      ]
    });

    assert.equal(collection.name, "Example APIs");
    assert.equal(collection.requestCount, 1);
    assert.deepEqual(collection.requests[0].folderPath, ["Adjustments"]);
    assert.equal(collection.requests[0].request.method, "POST");
    assert.equal(collection.requests[0].request.path, "/operations/adjustments");
    assert.equal(collection.requests[0].request.headers?.["X-Trace"], "{{trace_id}}");
    assert.equal(collection.requests[0].request.headers?.["Content-Type"], "application/json");
    assert.equal(collection.requests[0].request.headers?.Accept, "*/*");
    assert.equal(collection.requests[0].request.rawBody, "{\"amount\":\"{{amount}}\"}");
    assert.ok(collection.requests[0].variableNames.includes("amount"));
    assert.ok(collection.requests[0].variableNames.includes("tenant"));

    const operations = importedOperationsFromCollections({ version: 1, collections: [collection] });
    const operation = operations[collection.requests[0].operationKey];
    assert.equal(operation.source?.collectionName, "Example APIs");
    assert.equal(operation.params?.amount.required, false);
  });

  it("keeps imported request templates separate from workflow request overrides", async () => {
    const collection = parsePostmanCollection({
      info: { name: "Cards" },
      item: [
        {
          name: "Create case",
          request: {
            method: "POST",
            url: "{{baseUrl}}/cases",
            header: [{ key: "X-Original", value: "template" }],
            body: { mode: "raw", raw: "{\"case\":\"{{case_id}}\"}" }
          }
        }
      ]
    });
    const importedCatalogs: Catalogs = {
      ...catalogs,
      apiOperations: {
        ...catalogs.apiOperations,
        ...importedOperationsFromCollections({ version: 1, collections: [collection] })
      }
    };
    const operationKey = collection.requests[0].operationKey;
    const flow: FlowFile = {
      version: 1,
      id: "override_flow",
      environment: "local",
      nodes: [
        {
          id: "create_case",
          type: "api_operation",
          operation: operationKey,
          input: {
            case_id: "4111111111111111"
          },
          request: {
            headers: { "X-Original": "workflow", "X-New": "override" },
            rawBody: "{\"case\":\"{{case_id}}\",\"mode\":\"test\"}",
            bodyMode: "json"
          }
        }
      ]
    };

    const validation = await validateFlow(flow, importedCatalogs, process.cwd());
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    const compiled = compileFlow(flow);
    assert.equal(compiled.scenario.steps[0].request?.headers?.["X-New"], "override");

    const merged = mergeApiRequest(importedCatalogs.apiOperations[operationKey], flow.nodes[0].request);
    assert.equal(merged.headers?.["X-Original"], "workflow");
    assert.equal(importedCatalogs.apiOperations[operationKey].headers?.["X-Original"], "template");
  });

  it("allows API request fields to use prior step captures directly", async () => {
    const flow: FlowFile = {
      version: 1,
      id: "api_chaining",
      environment: "local",
      nodes: [
        {
          id: "login",
          type: "api_operation",
          operation: "board_financial_account",
          capture: {
            token: "$.token",
            amount: "$.amount"
          }
        },
        {
          id: "create_case",
          type: "api_operation",
          operation: "board_financial_account",
          request: {
            method: "POST",
            path: "/cases",
            headers: {
              Authorization: "Bearer ${login.token}"
            },
            rawBody: "{\"token\":\"${login.token}\",\"amount\":${login.amount}}",
            bodyMode: "json"
          }
        }
      ]
    };

    const validation = await validateFlow(flow, catalogs, process.cwd());
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    const compiled = compileFlow(flow);
    assert.equal(compiled.scenario.steps[1].request?.headers?.Authorization, "Bearer ${login.token}");
    assert.match(compiled.scenario.steps[1].request?.rawBody ?? "", /\$\{login\.token\}/);
  });

  it("compiles parallel and fixed-count loop control nodes", async () => {
    const flow: FlowFile = {
      version: 1,
      id: "control_flow",
      environment: "local",
      nodes: [
        {
          id: "parallel_checks",
          type: "parallel",
          join: "all",
          branches: [
            {
              id: "left",
              nodes: [{ id: "left_api", type: "api_operation", operation: "board_financial_account" }]
            },
            {
              id: "right",
              nodes: [{ id: "right_db", type: "db_query", query: "test_activity_exists", params: { account_number: "A1" } }]
            }
          ]
        },
        {
          id: "repeat_api",
          type: "loop",
          loop: { mode: "count", count: 2 },
          nodes: [{ id: "loop_api", type: "api_operation", operation: "board_financial_account" }]
        }
      ]
    };

    const validation = await validateFlow(flow, catalogs, process.cwd());
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    const compiled = compileFlow(flow);
    assert.equal(compiled.scenario.steps[0].control, "parallel");
    assert.equal(compiled.scenario.steps[0].branches?.length, 2);
    assert.equal(compiled.scenario.steps[1].control, "loop");
    assert.equal(compiled.scenario.steps[1].steps?.[0].id, "loop_api");
  });

  it("does not let non-linear canvas edges reorder execution", () => {
    const flow: FlowFile = {
      version: 1,
      id: "manual_canvas_flow",
      environment: "local",
      ui: { manualEdges: true },
      nodes: [
        { id: "a", type: "api_operation", operation: "board_financial_account" },
        { id: "b", type: "api_operation", operation: "board_financial_account" },
        { id: "c", type: "api_operation", operation: "board_financial_account" },
        { id: "d", type: "api_operation", operation: "board_financial_account" }
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "c", to: "d" }
      ]
    };

    const compiled = compileFlow(flow);
    assert.deepEqual(compiled.scenario.steps.map((step) => step.id), ["a", "b", "c", "d"]);

    const linearButManual = {
      ...flow,
      edges: [
        { from: "d", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "c" }
      ]
    };
    assert.deepEqual(compileFlow(linearButManual).scenario.steps.map((step) => step.id), ["a", "b", "c", "d"]);
  });

  it("validates loop child references as an ordered sequence", async () => {
    const flow: FlowFile = {
      version: 1,
      id: "loop_sequence_refs",
      environment: "local",
      nodes: [
        {
          id: "cycle",
          type: "loop",
          loop: { mode: "count", count: 2 },
          nodes: [
            {
              id: "create_account",
              type: "api_operation",
              operation: "board_financial_account",
              capture: { account_number: "$.account.accountNumber" }
            },
            {
              id: "check_account",
              type: "db_query",
              query: "test_activity_exists",
              params: { account_number: "${create_account.account_number}" }
            }
          ]
        },
        {
          id: "after_cycle",
          type: "api_operation",
          operation: "board_financial_account",
          request: { path: "/after/${cycle.last.check_account.adjustment_count}" }
        }
      ]
    };

    const validation = await validateFlow(flow, catalogs, process.cwd());
    assert.equal(validation.ok, true, validation.errors.join("\n"));
  });

  it("executes foreach loops and publishes indexed captures", async () => {
    const server = await startApiFixture((req, res) => {
      const url = req.url ?? "";
      const value = url.startsWith("/after/")
        ? decodeURIComponent(url.slice("/after/".length))
        : decodeURIComponent(url.split("/").pop() ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value }));
    });
    try {
      const runner = new ScenarioRunner({
        id: "loop_runtime",
        environment: "test",
        variables: {
          cases: ["A", "B"]
        },
        steps: [
          {
            id: "case_loop",
            action: "__loop",
            via: "control",
            control: "loop",
            loop: { mode: "foreach", items: "${cases}", itemName: "case", maxIterations: 10 },
            steps: [
              {
                id: "echo_case",
                action: "echo_case",
                via: "api",
                request: { path: "/echo/${case_loop.index}/${case}" },
                capture: { echoed: "$.value" }
              }
            ]
          },
          {
            id: "after_loop",
            action: "echo_case",
            via: "api",
            request: { path: "/after/${case_loop[0].echo_case.echoed}/${case_loop.last.echo_case.echoed}" },
            capture: { after: "$.value" }
          }
        ]
      }, {
        ...catalogs,
        apiOperations: {
          ...catalogs.apiOperations,
          echo_case: { type: "rest", method: "GET", path: "/echo" }
        }
      }, envFor(server.url), { rootDir: process.cwd() });

      const result = await runner.run();
      assert.equal(result.status, "passed");
      assert.equal(result.steps.find((step) => step.stepId === "after_loop")?.captures.after, "A/B");
      assert.deepEqual(result.steps.find((step) => step.stepId === "case_loop")?.captures["case_loop.all.echo_case.echoed"], ["A", "B"]);
    } finally {
      await server.close();
    }
  });

  it("computes loop business date cursor values for cycle simulations", async () => {
    const server = await startApiFixture((req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture.local");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: url.searchParams.get("value") }));
    });
    try {
      const result = await new ScenarioRunner({
        id: "loop_dates",
        environment: "test",
        steps: [
          {
            id: "cycle_loop",
            action: "__loop",
            via: "control",
            control: "loop",
            loop: {
              mode: "count",
              count: 3,
              dateCursor: {
                outputName: "business_date",
                start: "05/02/2027",
                inputFormat: "DD/MM/YYYY",
                outputFormat: "DD/MM/YYYY",
                advance: { mode: "nth_day_of_month", day: 15, amount: 1 }
              }
            },
            steps: [
              {
                id: "echo_date",
                action: "echo_date",
                via: "api",
                request: { path: "/date?value=${cycle_loop.business_date}" },
                capture: { date: "$.value" }
              }
            ]
          },
          {
            id: "month_end_loop",
            action: "__loop",
            via: "control",
            control: "loop",
            loop: {
              mode: "count",
              count: 3,
              dateCursor: {
                outputName: "business_date",
                start: "10/01/2027",
                inputFormat: "DD/MM/YYYY",
                outputFormat: "DD/MM/YYYY",
                advance: { mode: "end_of_month", amount: 1 }
              }
            },
            steps: [
              {
                id: "echo_end_date",
                action: "echo_date",
                via: "api",
                request: { path: "/date?value=${month_end_loop.business_date}" },
                capture: { date: "$.value" }
              }
            ]
          }
        ]
      }, {
        ...catalogs,
        apiOperations: {
          ...catalogs.apiOperations,
          echo_date: { type: "rest", method: "GET", path: "/date" }
        }
      }, envFor(server.url), { rootDir: process.cwd() }).run();

      assert.equal(result.status, "passed");
      assert.deepEqual(result.steps.find((step) => step.stepId === "cycle_loop")?.captures["cycle_loop.all.business_date"], ["15/02/2027", "15/03/2027", "15/04/2027"]);
      assert.deepEqual(result.steps.find((step) => step.stepId === "cycle_loop")?.captures["cycle_loop.all.echo_date.date"], ["15/02/2027", "15/03/2027", "15/04/2027"]);
      assert.deepEqual(result.steps.find((step) => step.stepId === "month_end_loop")?.captures["month_end_loop.all.business_date"], ["31/01/2027", "28/02/2027", "31/03/2027"]);
    } finally {
      await server.close();
    }
  });

  it("generates runtime headers and avoids duplicated base URL paths", () => {
    assert.equal(
      requestPathForBase("/suite/api/Auth", "https://example.test/suite/api"),
      "/Auth"
    );
    assert.equal(
      requestPathForBase("/suite/api/Auth", "https://example.test"),
      "/suite/api/Auth"
    );
    assert.equal(withGeneratedHeaders({ bodyMode: "json" }).headers?.["Content-Type"], "application/json");
  });

  it("does not preserve standalone backslash lines in JSON request bodies", async () => {
    let received = "";
    const server = await startApiFixture((req, res) => {
      req.on("data", (chunk) => { received += String(chunk); });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    try {
      await new RestClient(envFor(server.url), process.cwd()).execute(
        {
          type: "rest",
          method: "POST",
          path: "/create-case",
          bodyMode: "json",
          rawBody: "{\n  \"requestInfo\": {},\n\\\n  \"customerDetails\": {\"bankCode\":\"000076\"}\n}"
        },
        {}
      );

      assert.deepEqual(JSON.parse(received), {
        requestInfo: {},
        customerDetails: { bankCode: "000076" }
      });
    } finally {
      await server.close();
    }
  });

  it("writes multiline flow request bodies as YAML block scalars", () => {
    const yaml = flowToYaml({
      version: 1,
      id: "body_yaml",
      environment: "local",
      nodes: [
        {
          id: "create_case",
          type: "api_operation",
          operation: "board_financial_account",
          request: {
            method: "POST",
            path: "/cases",
            bodyMode: "json",
            rawBody: "{\n  \"case\": \"123\"\n}"
          }
        }
      ]
    });

    assert.match(yaml, /rawBody: \|-/);
    assert.doesNotMatch(yaml, /rawBody: "\\{/);
  });

  it("captures unaccepted HTTP 406 as business response evidence without publishing captures", async () => {
    const server = await startApiFixture((req, res) => {
      res.writeHead(406, { "content-type": "application/json" });
      res.end(JSON.stringify({ responseInfo: { code: "CASE_NOT_FOUND" }, message: "case not found", token: "debug-token" }));
    });
    try {
      const result = await new RestClient(envFor(server.url), process.cwd()).execute(
        { type: "rest", method: "POST", path: "/search" },
        {},
        undefined,
        [{ type: "body_contains", value: "case not found" }],
        { token: "$.token" }
      );

      assert.equal(result.apiEvidence.response?.status, 406);
      assert.equal(result.apiEvidence.finalStatus, "failed");
      assert.equal(result.apiEvidence.assertionResults[0].passed, true);
      assert.equal(result.apiEvidence.evidenceCaptures[0].status, "extracted");
      assert.equal(result.apiEvidence.evidenceCaptures[0].published, false);
      assert.deepEqual(result.captures, {});
      assert.match(result.apiEvidence.response?.bodyText ?? "", /case not found/);
    } finally {
      await server.close();
    }
  });

  it("passes negative HTTP 406 when accepted and publishes captures", async () => {
    const server = await startApiFixture((req, res) => {
      res.writeHead(406, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "case not found", token: "debug-token" }));
    });
    try {
      const result = await new RestClient(envFor(server.url), process.cwd()).execute(
        { type: "rest", method: "POST", path: "/search" },
        {},
        { acceptStatuses: [406] },
        [{ type: "body_contains", value: "case not found" }],
        { token: "$.token" },
        { expectedOutcome: "negative" }
      );

      assert.equal(result.apiEvidence.finalStatus, "passed");
      assert.equal(result.apiEvidence.statusAccepted, true);
      assert.equal(result.apiEvidence.evidenceCaptures[0].published, true);
      assert.equal(result.captures.token, "debug-token");
    } finally {
      await server.close();
    }
  });

  it("treats explicit accepted statuses as authoritative", async () => {
    const server = await startApiFixture((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "unexpected success", token: "debug-token" }));
    });
    try {
      const result = await new RestClient(envFor(server.url), process.cwd()).execute(
        { type: "rest", method: "POST", path: "/search" },
        {},
        { acceptStatuses: [406] },
        [{ type: "body_contains", value: "unexpected success" }],
        { token: "$.token" },
        { expectedOutcome: "negative" }
      );

      assert.equal(result.apiEvidence.response?.status, 200);
      assert.equal(result.apiEvidence.finalStatus, "failed");
      assert.equal(result.apiEvidence.assertionResults[0].passed, true);
      assert.equal(result.apiEvidence.evidenceCaptures[0].published, false);
      assert.deepEqual(result.captures, {});
    } finally {
      await server.close();
    }
  });

  it("explains missing captures with available response fields", async () => {
    const server = await startApiFixture((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        responseInfo: { resultID: "ProceedWithSuccess", errorCode: "00000" },
        caseId: "4537850208919276"
      }));
    });
    try {
      const result = await new RestClient(envFor(server.url), process.cwd()).execute(
        { type: "rest", method: "POST", path: "/create-case" },
        {},
        undefined,
        [],
        { token: "$.token" }
      );

      assert.equal(result.apiEvidence.finalStatus, "failed");
      assert.match(result.apiEvidence.evidenceCaptures[0].message ?? "", /\$\.caseId/);
      assert.match(result.apiEvidence.evidenceCaptures[0].message ?? "", /\$\.responseInfo\.resultID/);
    } finally {
      await server.close();
    }
  });

  it("retries transient HTTP statuses after validateStatus true", async () => {
    let attempts = 0;
    const server = await startApiFixture((req, res) => {
      attempts += 1;
      if (attempts < 3) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "try again" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const result = await new RestClient(envFor(server.url), process.cwd()).execute(
        { type: "rest", method: "GET", path: "/flaky" },
        {}
      );
      assert.equal(attempts, 3);
      assert.equal(result.apiEvidence.response?.status, 200);
      assert.equal(result.apiEvidence.finalStatus, "passed");
    } finally {
      await server.close();
    }
  });

  it("uses raw evidence by default and redacts only in redacted mode", () => {
    const payload = { headers: { Authorization: "Bearer abcdef123456" }, body: { servicePassword: "secret", pan: "5200123412341234" } };
    assert.deepEqual(applyEvidenceVisibility(payload, "raw"), payload);
    const redacted = applyEvidenceVisibility(payload, "redacted");
    assert.notEqual(redacted.headers.Authorization, payload.headers.Authorization);
    assert.notEqual(redacted.body.servicePassword, payload.body.servicePassword);
    assert.notEqual(redacted.body.pan, payload.body.pan);
  });

  it("guards binary responses for run dock evidence", async () => {
    const server = await startApiFixture((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 3, 4]));
    });
    try {
      const result = await new RestClient(envFor(server.url), process.cwd()).execute(
        { type: "rest", method: "GET", path: "/binary" },
        {}
      );
      assert.equal(result.apiEvidence.response?.bodyPreviewKind, "binary");
      assert.match(String(result.apiEvidence.response?.body), /binary/);
    } finally {
      await server.close();
    }
  });

  it("skips disabled flow nodes when compiling", () => {
    const flow: FlowFile = {
      version: 1,
      id: "disabled_flow",
      environment: "local",
      nodes: [
        {
          id: "disabled_step",
          type: "api_operation",
          operation: "board_financial_account",
          disabled: true
        },
        {
          id: "enabled_step",
          type: "api_operation",
          operation: "board_financial_account"
        }
      ]
    };

    const compiled = compileFlow(flow);
    assert.deepEqual(compiled.scenario.steps.map((step) => step.id), ["enabled_step"]);
  });

  it("resolves Postman-style variables in run context", () => {
    const context = new RunContext({
      id: "postman_vars",
      environment: "local",
      variables: {
        token: "abc",
        amount: 42
      },
      steps: []
    });

    assert.deepEqual(context.resolve({
      authorization: "Bearer {{token}}",
      amount: "{{amount}}"
    }), {
      authorization: "Bearer abc",
      amount: 42
    });
  });

  it("evaluates API response assertions", () => {
    assert.doesNotThrow(() => assertApiResponse({
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json" },
      config: {},
      data: { adjustment: { id: "A1", status: "CAPTURED" } }
    }, [
      { type: "status", value: [200, 201] },
      { type: "jsonpath_exists", path: "$.adjustment.id" },
      { type: "jsonpath_equals", path: "$.adjustment.status", value: "CAPTURED" },
      { type: "header_exists", header: "content-type" }
    ]));
  });
});

function envFor(apiBaseUrl: string) {
  return { name: "test", apiBaseUrl, oracle: {}, sshHosts: {} };
}

async function startApiFixture(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
