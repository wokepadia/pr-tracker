import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const onboardingVersion = 1;

export interface LocalOnboardingState {
  completedAt?: string;
  introSkippedAt?: string;
  version: number;
}

export interface LocalOnboardingSettingsOptions {
  configPath?: string;
}

export async function getLocalOnboardingState(
  options: LocalOnboardingSettingsOptions = {}
): Promise<LocalOnboardingState> {
  return readLocalOnboardingState(options.configPath);
}

export async function saveLocalOnboardingState(
  input: Partial<LocalOnboardingState>,
  options: LocalOnboardingSettingsOptions = {}
): Promise<LocalOnboardingState> {
  const state: LocalOnboardingState = {
    version: normalizeVersion(input.version),
    completedAt: cleanOptionalString(input.completedAt),
    introSkippedAt: cleanOptionalString(input.introSkippedAt)
  };

  await writeLocalOnboardingState(state, options.configPath);
  return state;
}

async function readLocalOnboardingState(
  configPath = defaultConfigPath()
): Promise<LocalOnboardingState> {
  const raw = await readFile(configPath, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  });

  if (!raw) {
    return { version: onboardingVersion };
  }

  const parsed = JSON.parse(raw) as {
    completedAt?: unknown;
    introSkippedAt?: unknown;
    version?: unknown;
  };

  return {
    version: normalizeVersion(parsed.version),
    completedAt:
      typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
    introSkippedAt:
      typeof parsed.introSkippedAt === "string"
        ? parsed.introSkippedAt
        : undefined
  };
}

async function writeLocalOnboardingState(
  state: LocalOnboardingState,
  configPath = defaultConfigPath()
): Promise<void> {
  const directory = path.dirname(configPath);
  const temporaryPath = `${configPath}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600).catch(() => undefined);
}

function defaultConfigPath(): string {
  if (process.env.PR_TRACKER_ONBOARDING_SETTINGS_PATH) {
    return process.env.PR_TRACKER_ONBOARDING_SETTINGS_PATH;
  }

  return path.join(
    homedir(),
    "Library",
    "Application Support",
    "pr-tracker",
    "onboarding-settings.json"
  );
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : onboardingVersion;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
