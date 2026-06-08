import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseGithubRepositories } from "@pr-tracker/github";

const keychainService = "pr-tracker.github-token";
const keychainAccount = "github-token";
let macosKeychainCachedToken: string | undefined;

export interface LocalGithubSettings {
  repositories: string[];
  viewerLogin?: string;
  apiBaseUrl?: string;
  tokenConfigured: boolean;
}

export interface LocalGithubCredentials
  extends Omit<LocalGithubSettings, "tokenConfigured"> {
  token: string;
}

export interface LocalGithubSettingsStatus extends LocalGithubSettings {
  tokenConfigured: boolean;
  storage: "macos-keychain";
}

export interface LocalGithubSettingsStore {
  readToken(): Promise<string | undefined>;
  writeToken(token: string): Promise<void>;
}

export interface LocalGithubSettingsOptions {
  configPath?: string;
  store?: LocalGithubSettingsStore;
}

export async function getLocalGithubSettingsStatus(
  options: LocalGithubSettingsOptions = {}
): Promise<LocalGithubSettingsStatus> {
  let settings = await readLocalGithubSettings(options.configPath);
  if (!settings.tokenConfigured && settings.repositories.length > 0) {
    const tokenConfigured = Boolean(
      await getSettingsStore(options.store).readToken()
    );
    if (tokenConfigured) {
      settings = { ...settings, tokenConfigured };
      await writeLocalGithubSettings(settings, options.configPath);
    }
  }

  return {
    repositories: settings.repositories,
    viewerLogin: settings.viewerLogin,
    apiBaseUrl: settings.apiBaseUrl,
    tokenConfigured: settings.tokenConfigured,
    storage: "macos-keychain"
  };
}

export async function saveLocalGithubSettings(
  input: {
    token?: string;
    repositories: string[] | string;
    viewerLogin?: string;
    apiBaseUrl?: string;
  },
  options: LocalGithubSettingsOptions = {}
): Promise<LocalGithubSettingsStatus> {
  const repositories = Array.isArray(input.repositories)
    ? parseGithubRepositories(input.repositories.join(","))
    : parseGithubRepositories(input.repositories);
  if (repositories.length === 0) {
    throw new Error("At least one GitHub repository is required.");
  }

  const token = input.token?.trim();
  const store = getSettingsStore(options.store);
  const existingSettings = await readLocalGithubSettings(options.configPath);
  let tokenConfigured = existingSettings.tokenConfigured;

  if (token) {
    await store.writeToken(token);
    tokenConfigured = true;
  }

  if (!tokenConfigured) {
    tokenConfigured = Boolean(await store.readToken());
  }

  if (!tokenConfigured) {
    throw new Error("A GitHub token is required.");
  }

  await writeLocalGithubSettings(
    {
      repositories,
      viewerLogin: cleanOptionalString(input.viewerLogin),
      apiBaseUrl: cleanOptionalString(input.apiBaseUrl),
      tokenConfigured
    },
    options.configPath
  );

  return {
    repositories,
    viewerLogin: cleanOptionalString(input.viewerLogin),
    apiBaseUrl: cleanOptionalString(input.apiBaseUrl),
    tokenConfigured,
    storage: "macos-keychain"
  };
}

export async function loadLocalGithubCredentials(
  options: LocalGithubSettingsOptions = {}
): Promise<LocalGithubCredentials | undefined> {
  const settings = await readLocalGithubSettings(options.configPath);
  if (settings.repositories.length === 0) {
    return undefined;
  }

  const token = await getSettingsStore(options.store).readToken();
  if (!token) {
    throw new Error(
      "GitHub settings are saved, but the Keychain token is missing. Re-enter your GitHub token in Settings."
    );
  }

  return {
    ...settings,
    token
  };
}

export function localGithubSettingsFingerprint(
  credentials: LocalGithubCredentials
): string {
  return JSON.stringify({
    repositories: credentials.repositories,
    viewerLogin: credentials.viewerLogin,
    apiBaseUrl: credentials.apiBaseUrl,
    tokenLength: credentials.token.length
  });
}

export function createMemoryGithubSettingsStore(
  initialToken?: string
): LocalGithubSettingsStore {
  let token = initialToken;

  return {
    async readToken() {
      return token;
    },
    async writeToken(nextToken) {
      token = nextToken;
    }
  };
}

function getSettingsStore(
  override: LocalGithubSettingsStore | undefined
): LocalGithubSettingsStore {
  return override ?? macosKeychainGithubSettingsStore;
}

async function readLocalGithubSettings(
  configPath = defaultConfigPath()
): Promise<LocalGithubSettings> {
  const raw = await readFile(configPath, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  });

  if (!raw) {
    return { repositories: [], tokenConfigured: false };
  }

  const parsed = JSON.parse(raw) as {
    repositories?: unknown;
    viewerLogin?: unknown;
    apiBaseUrl?: unknown;
    tokenConfigured?: unknown;
  };

  return {
    repositories: Array.isArray(parsed.repositories)
      ? parseGithubRepositories(parsed.repositories.join(","))
      : [],
    viewerLogin:
      typeof parsed.viewerLogin === "string" ? parsed.viewerLogin : undefined,
    apiBaseUrl:
      typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl : undefined,
    tokenConfigured: parsed.tokenConfigured === true
  };
}

async function writeLocalGithubSettings(
  settings: LocalGithubSettings,
  configPath = defaultConfigPath()
): Promise<void> {
  const directory = path.dirname(configPath);
  const temporaryPath = `${configPath}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600).catch(() => undefined);
}

function defaultConfigPath(): string {
  if (process.env.PR_TRACKER_GITHUB_SETTINGS_PATH) {
    return process.env.PR_TRACKER_GITHUB_SETTINGS_PATH;
  }

  return path.join(
    homedir(),
    "Library",
    "Application Support",
    "pr-tracker",
    "github-settings.json"
  );
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const macosKeychainGithubSettingsStore: LocalGithubSettingsStore = {
  async readToken() {
    if (macosKeychainCachedToken) {
      return macosKeychainCachedToken;
    }

    if (process.platform !== "darwin") {
      throw new Error("Local token storage currently requires macOS Keychain.");
    }

    const result = await runSecurity([
      "find-generic-password",
      "-a",
      keychainAccount,
      "-s",
      keychainService,
      "-w"
    ]);

    if (result.exitCode === 44) {
      return undefined;
    }

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Failed to read token from Keychain.");
    }

    macosKeychainCachedToken = result.stdout.trim() || undefined;
    return macosKeychainCachedToken;
  },

  async writeToken(token) {
    if (process.platform !== "darwin") {
      throw new Error("Local token storage currently requires macOS Keychain.");
    }

    const result = await runSecurity([
      "add-generic-password",
      "-a",
      keychainAccount,
      "-s",
      keychainService,
      "-w",
      token,
      "-U"
    ]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Failed to save token to Keychain.");
    }

    macosKeychainCachedToken = token;
  }
};

function runSecurity(args: string[]): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr: stderr.trim() });
    });
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
