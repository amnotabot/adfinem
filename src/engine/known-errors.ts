export interface KnownErrorMessage {
  message: string;
  hints: string[];
}

export function explainKnownError(error: unknown): KnownErrorMessage {
  const err = error instanceof Error ? error : new Error(String(error));
  const text = `${err.name}: ${err.message}`;
  const hints: string[] = [];
  let message = err.message;

  if (/Invalid JSON for --params|Invalid JSON value for --param/i.test(text)) {
    hints.push("In PowerShell, prefer repeated --param name=value options instead of --params JSON.");
    hints.push("Example: --param case_id=CASE-1001 --param case_id=CASE-1002");
  }
  if (/Invalid JSON for --input/i.test(text)) {
    hints.push("In PowerShell, wrap JSON input in single quotes or escape double quotes.");
    hints.push("Example: --input '{\"application_id\":\"000000000000000000001452\"}'");
  }

  if (err instanceof SyntaxError && (/json/i.test(err.message) || /Expected property name|Unexpected token|Unexpected end/.test(err.message))) {
    message = `Invalid JSON argument: ${err.message}`;
    hints.push("In PowerShell, prefer repeated --param name=value options instead of --params JSON.");
    hints.push("Example: --param case_id=CASE-1001 --param case_id=CASE-1002");
  }

  if (/ADFINEM_DB_USER|ADFINEM_DB_PASSWORD|ADFINEM_DB_CONNECT_STRING/.test(text)) {
    hints.push("Set ADFINEM_DB_USER, ADFINEM_DB_PASSWORD, and ADFINEM_DB_CONNECT_STRING in .env or your shell.");
    hints.push("Example connect string: <host>:1521/<service>");
  }

  if (/DPI-1047|Cannot locate an Oracle Client library/i.test(text)) {
    message = "Oracle client libraries are not available to node-oracledb.";
    hints.push("Install/configure Oracle Instant Client and make sure its directory is on PATH.");
  }

  if (/oracledb\.getConnection is not a function|did not expose getConnection/i.test(text)) {
    message = "The oracledb module loaded in an unexpected shape.";
    hints.push("Run npm install again, then npm run build. This runner supports both ESM default and direct oracledb exports.");
  }

  addOracleHint(text, hints);
  addSshHint(text, hints);
  addCatalogHint(text, hints);

  return { message, hints: unique(hints) };
}

export function formatKnownError(error: unknown): string {
  const explained = explainKnownError(error);
  if (!explained.hints.length) return explained.message;
  return [
    explained.message,
    "",
    "Hints:",
    ...explained.hints.map((hint) => `- ${hint}`)
  ].join("\n");
}

function addOracleHint(text: string, hints: string[]): void {
  if (/ORA-01017/.test(text)) {
    hints.push("Oracle rejected the username/password. Check ADFINEM_DB_USER and ADFINEM_DB_PASSWORD.");
  }
  if (/ORA-28000/.test(text)) {
    hints.push("Oracle account is locked. Unlock/reset the DB user before rerunning.");
  }
  if (/ORA-12154/.test(text)) {
    hints.push("Oracle could not resolve the connect identifier. Check ADFINEM_DB_CONNECT_STRING.");
  }
  if (/ORA-12514/.test(text)) {
    hints.push("Oracle listener does not know the requested service. Check the service name in ADFINEM_DB_CONNECT_STRING.");
  }
  if (/ORA-12541|ECONNREFUSED/.test(text)) {
    hints.push("Oracle listener connection was refused. Check host, port, VPN, and listener status.");
  }
  if (/ORA-12170|ETIMEDOUT|NJS-510|NJS-511/.test(text)) {
    hints.push("Oracle connection timed out. Check network/VPN/firewall and DB host reachability.");
  }
  if (/ORA-00942/.test(text)) {
    hints.push("Table or view does not exist for this schema, or the DB user lacks privileges.");
  }
  if (/ORA-00904/.test(text)) {
    hints.push("Invalid column name. Check the Action Library SQL against the target environment schema.");
  }
  if (/ORA-01036|NJS-098/.test(text)) {
    hints.push("SQL bind mismatch. Check Action Library parameter names and supplied --param values.");
  }
  if (/ORA-01722/.test(text)) {
    hints.push("Invalid number. Use json: for numeric --param values, for example --param amount=json:111.");
  }
}

function addSshHint(text: string, hints: string[]): void {
  if (/Unknown SSH hostRef/.test(text)) {
    hints.push("Add the hostRef under sshHosts in config/environments.yaml.");
  }
  if (/requires host and username/.test(text)) {
    hints.push("Set the SSH host and username in config/environments.yaml/.env.");
  }
  if (/All configured authentication methods failed|Permission denied/i.test(text)) {
    hints.push("SSH authentication failed. Check ADFINEM_SSH_USER, ADFINEM_SSH_PASSWORD, or ADFINEM_SSH_PRIVATE_KEY_PATH.");
  }
  if (/ENOTFOUND|getaddrinfo/.test(text)) {
    hints.push("SSH host name could not be resolved. Check the host value and VPN/DNS.");
  }
  if (/ECONNREFUSED/.test(text)) {
    hints.push("SSH connection was refused. Check host, port, firewall, and sshd status.");
  }
  if (/timed out|ETIMEDOUT/i.test(text)) {
    hints.push("SSH command or connection timed out. Check server load, VPN, and the Action Library timeoutSeconds.");
  }
  if (/exit code 127|No such file or directory|command not found|not found/i.test(text)) {
    hints.push("The Unix command did not find the batch script. Set ADFINEM_BATCH_WORKDIR in .env, or put an absolute script path in the Action Library batch template.");
    hints.push("If the script lives on the remote server, ADFINEM_BATCH_WORKDIR must be the remote directory that contains reconcile_nightly.sh, generate_report.sh, and the other batch scripts.");
    hints.push("If the command works only after an interactive SSH login, enable 'Run commands in login shell' for the SSH host in Environments.");
  }
  if (/ENOENT.*private|no such file/i.test(text)) {
    hints.push("SSH private key path does not exist. Check ADFINEM_SSH_PRIVATE_KEY_PATH.");
  }
}

function addCatalogHint(text: string, hints: string[]): void {
  if (/Unknown API operation/.test(text)) {
    hints.push("Run against an API operation present in the Action Library file catalogs/api-operations.yaml.");
  }
  if (/Unknown query/.test(text)) {
    hints.push("Run against a query template present in the Action Library file catalogs/queries.yaml.");
  }
  if (/Unknown batch/.test(text)) {
    hints.push("Run against a batch template present in the Action Library file catalogs/batches.yaml.");
  }
  if (/Missing required query param|Missing required batch arg/.test(text)) {
    hints.push("Supply missing values with --param name=value or scenario params/input.");
  }
  if (/Capture expression .* did not match/i.test(text)) {
    hints.push("A required capture did not exist in the action output. If this value is legitimately optional for the flow, prefix the capture expression with optional: in the Action Library template.");
  }
  if (/must be string\[\]|must contain at least one value/.test(text)) {
    hints.push("For list params, pass one value or repeat --param. Example: --param case_id=CASE-1001 --param case_id=CASE-1002");
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
