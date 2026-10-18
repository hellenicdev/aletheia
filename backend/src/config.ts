export interface Env {
  OPENAI_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  TAVILY_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  RATE_LIMIT_PER_IP?: string;
  RATE_LIMIT_WINDOW_SEC?: string;
  /** Tavily credits reserved per UTC day. Default 120. A var, not a secret. */
  TAVILY_DAILY_CREDITS?: string;
  /** Tavily credits reserved per calendar month. Default 950. A var, not a secret. */
  TAVILY_MONTHLY_CREDITS?: string;
  /** Edge guard: 3 requests per 60 seconds for one IP. The Durable Objects are stricter. */
  ANALYZE_IP?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  IP_LIMITER?: DurableObjectNamespace;
  TAVILY_CREDITS?: DurableObjectNamespace;
  PIPELINE_CACHE?: DurableObjectNamespace;
  /**
   * Set to "1" only for local wrangler dev and tests. Production must leave
   * this unset so a missing Durable Object binding is a 503, not an in-memory limit.
   */
  ALLOW_MEMORY_LIMITER?: string;
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
  "https://www.hellenicdev.eu",
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
