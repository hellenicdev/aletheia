export interface Env {
  OPENAI_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  TAVILY_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  RATE_LIMIT_PER_IP?: string;
  RATE_LIMIT_WINDOW_SEC?: string;
}

export interface AppConfig {
  llmBaseUrl: string;
  llmModel: string;
  allowedOrigins: string[];
  rateLimit: number;
  rateWindowMs: number;
  searchConfigured: boolean;
}

export const DEFAULT_ORIGINS = [
  "https://hellenicdev.eu",
  "https://hellenicdev.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

export function resolveConfig(env: Env): AppConfig {
  const origins = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    llmBaseUrl: (env.OPENAI_BASE_URL || "https://api.reflection.ai/openai/v1").replace(
      /\/$/,
      "",
    ),
    llmModel: env.OPENAI_MODEL || "Beam-501B-A23B",
    allowedOrigins: origins,
    rateLimit: positiveInt(env.RATE_LIMIT_PER_IP, 30),
    rateWindowMs: positiveInt(env.RATE_LIMIT_WINDOW_SEC, 600) * 1000,
    searchConfigured: Boolean(
      (env.FIRECRAWL_API_KEY && env.FIRECRAWL_API_KEY.trim()) ||
        (env.TAVILY_API_KEY && env.TAVILY_API_KEY.trim()),
    ),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
