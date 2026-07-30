import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LLMOptions } from "../../index.js";
import { osModelsEditPrompt } from "../templates/edit.js";
import OpenAI from "./OpenAI.js";

// ─── Auth file ───────────────────────────────────────────────────────────────
// Written by: bash ~/Documents/codex-oca-tool/codex-oca-temp.sh login
// Structure:  { "ocaApiKey": "<JWT access token>", ... }
const OCA_SECRETS_FILE = path.join(os.homedir(), ".codex", "oca-secrets.json");
const CLINE_PROVIDERS_FILE = path.join(
  os.homedir(),
  ".cline",
  "data",
  "settings",
  "providers.json",
);
const CLINE_SECRETS_FILE = path.join(
  os.homedir(),
  ".cline",
  "data",
  "secrets.json",
);

// OCA LiteLLM endpoint (Oracle internal)
const OCA_BASE_URL =
  "https://code-internal.aiservice.us-chicago-1.oci.oraclecloud.com/20250206/app/litellm";

// Required OCI client headers
const CLIENT_VERSION = "0.137.0";

function readOcaToken(): string {
  // 1. Use Cline's current OCA credential directly when it is available.
  try {
    if (fs.existsSync(CLINE_SECRETS_FILE)) {
      const secrets = JSON.parse(
        fs.readFileSync(CLINE_SECRETS_FILE, "utf8"),
      ) as { ocaApiKey?: unknown };
      const token = secrets.ocaApiKey;
      if (typeof token === "string" && token.trim()) return token.trim();
    }
  } catch {
    // fall through to Cline's provider settings
  }

  // 2. Fall back to Cline's provider settings for older Cline installations.
  try {
    if (fs.existsSync(CLINE_PROVIDERS_FILE)) {
      const settings = JSON.parse(
        fs.readFileSync(CLINE_PROVIDERS_FILE, "utf8"),
      ) as {
        providers?: {
          oca?: { settings?: { apiKey?: unknown } };
        };
      };
      const token = settings.providers?.oca?.settings?.apiKey;
      if (typeof token === "string" && token.trim()) return token.trim();
    }
  } catch {
    // fall through to the existing credential sources
  }

  // 3. Try the Codex secrets file managed by codex-oca-tool.
  try {
    if (fs.existsSync(OCA_SECRETS_FILE)) {
      const secrets = JSON.parse(
        fs.readFileSync(OCA_SECRETS_FILE, "utf8"),
      ) as Record<string, unknown>;
      const token = secrets?.ocaApiKey;
      if (typeof token === "string" && token.trim()) return token.trim();
    }
  } catch {
    // fall through to env var
  }

  // 4. Fall back to environment variable
  const envKey = process.env.OCA_API_KEY ?? "";
  if (envKey.trim()) return envKey.trim();

  throw new Error(
    `OCA auth not found.\n` +
      `Sign in to Cline with the OCA provider, or\n` +
      `Run: bash ~/Documents/codex-oca-tool/codex-oca-temp.sh login\n` +
      `This writes the access token to ${OCA_SECRETS_FILE}.\n` +
      `Alternatively, set the OCA_API_KEY environment variable or add it to ~/.qivryn/.env`,
  );
}

/**
 * OracleCodeAssist LLM provider for Qivryn.
 *
 * Connects **directly** to Oracle Code Assist's LiteLLM HTTPS endpoint —
 * no proxy, no daemon, no local server.
 *
 * Auth is managed automatically:
 *  - Reads Cline's current OCA credential from `~/.cline/data/secrets.json`.
 *  - Falls back to Cline provider settings, `~/.codex/oca-secrets.json`, then `OCA_API_KEY`.
 *  - Token is resolved when an OCA request is made. This keeps an unavailable
 *    optional provider from preventing other configured providers from loading,
 *    and picks up refreshed tokens without a config reload.
 *
 * Setup (one time):
 *   bash ~/Documents/codex-oca-tool/codex-oca-temp.sh login
 *
 * Token refresh (when expired):
 *   bash ~/Documents/codex-oca-tool/codex-oca-temp.sh refresh
 *   # Then reload VS Code (Developer: Reload Window)
 */
class OracleCodeAssist extends OpenAI {
  static providerName = "oca";

  static defaultOptions: Partial<LLMOptions> = {
    apiBase: `${OCA_BASE_URL}/`,
    model: "oca/gpt-5.3-codex",
    useLegacyCompletionsEndpoint: false,
    promptTemplates: {
      edit: osModelsEditPrompt,
    },
  };

  protected override _getHeaders() {
    // Resolve auth lazily so a missing OCA credential does not invalidate the
    // entire config or hide models from providers that are authenticated.
    const apiKey = this.apiKey?.trim() || readOcaToken();

    return {
      ...super._getHeaders(),
      Authorization: `Bearer ${apiKey}`,
      "api-key": apiKey,
      // Required Oracle Cloud Infrastructure headers
      client: "Qivryn",
      "client-version": CLIENT_VERSION,
      "client-ide": "vscode",
      "client-ide-version": CLIENT_VERSION,
    };
  }
}

export default OracleCodeAssist;
