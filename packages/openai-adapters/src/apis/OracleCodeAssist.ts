import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenAIApi } from "./OpenAI.js";
import { OpenAIConfig } from "../types.js";

const OCA_SECRETS_FILE = path.join(os.homedir(), ".codex", "oca-secrets.json");
const CLINE_SECRETS_FILE = path.join(
  os.homedir(),
  ".cline",
  "data",
  "secrets.json",
);
const CLINE_PROVIDERS_FILE = path.join(
  os.homedir(),
  ".cline",
  "data",
  "settings",
  "providers.json",
);
const OCA_BASE_URL =
  "https://code-internal.aiservice.us-chicago-1.oci.oraclecloud.com/20250206/app/litellm";
const CLIENT_VERSION = "0.137.0";

function readOcaToken(): string {
  try {
    if (fs.existsSync(CLINE_SECRETS_FILE)) {
      const secrets = JSON.parse(
        fs.readFileSync(CLINE_SECRETS_FILE, "utf8"),
      ) as { ocaApiKey?: unknown };
      const token = secrets.ocaApiKey;
      if (typeof token === "string" && token.trim()) return token.trim();
    }
  } catch {
    /* fall through */
  }

  try {
    if (fs.existsSync(CLINE_PROVIDERS_FILE)) {
      const settings = JSON.parse(
        fs.readFileSync(CLINE_PROVIDERS_FILE, "utf8"),
      ) as { providers?: { oca?: { settings?: { apiKey?: unknown } } } };
      const token = settings.providers?.oca?.settings?.apiKey;
      if (typeof token === "string" && token.trim()) return token.trim();
    }
  } catch {
    /* fall through */
  }

  try {
    if (fs.existsSync(OCA_SECRETS_FILE)) {
      const secrets = JSON.parse(
        fs.readFileSync(OCA_SECRETS_FILE, "utf8"),
      ) as Record<string, unknown>;
      const t = secrets?.ocaApiKey;
      if (typeof t === "string" && t.trim()) return t.trim();
    }
  } catch {
    /* fall through */
  }
  return process.env.OCA_API_KEY?.trim() ?? "";
}

export interface OracleCodeAssistConfig extends OpenAIConfig {}

/**
 * OracleCodeAssist API adapter for Qivryn's openai-adapters package.
 *
 * Talks directly to Oracle Code Assist's LiteLLM HTTPS endpoint — no proxy.
 * Reads Cline's current OCA credential first, then falls back to
 * ~/.codex/oca-secrets.json and the OCA_API_KEY environment variable.
 */
export class OracleCodeAssistApi extends OpenAIApi {
  constructor(config: OracleCodeAssistConfig) {
    super({
      ...config,
      apiBase: config.apiBase ?? `${OCA_BASE_URL}/`,
      apiKey: config.apiKey?.trim() || readOcaToken(),
    });
  }

  protected override getHeaders(): Record<string, string> {
    return {
      ...super.getHeaders(),
      client: "Qivryn",
      "client-version": CLIENT_VERSION,
      "client-ide": "vscode",
      "client-ide-version": CLIENT_VERSION,
    };
  }
}

export default OracleCodeAssistApi;
