export const appConfig = {
  name: "AwardPing",
  url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  alertFromEmail: process.env.ALERT_FROM_EMAIL || "AwardPing <alerts@example.com>",
  contactToEmail: process.env.CONTACT_TO_EMAIL || "",
  cronSecret: process.env.CRON_SECRET || "",
  dataEncryptionKey: process.env.APP_DATA_ENCRYPTION_KEY || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  aiProvider: process.env.AI_PROVIDER || "auto",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
  geminiDiscoveryModel:
    process.env.GEMINI_DISCOVERY_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash-lite",
  geminiSummaryModel:
    process.env.GEMINI_SUMMARY_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash-lite",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiDiscoveryModel: process.env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini",
  adminEmails: emailListFromEnv("AWARDPING_ADMIN_EMAILS"),
  discoveryDailyUserLimit: numberFromEnv("DISCOVERY_DAILY_USER_LIMIT", 10),
  discoveryDailyIpLimit: numberFromEnv("DISCOVERY_DAILY_IP_LIMIT", 30),
  discoveryDailyGlobalLimit: numberFromEnv("DISCOVERY_DAILY_GLOBAL_LIMIT", 100),
};

export function hasSupabaseConfig() {
  return Boolean(appConfig.supabaseUrl && appConfig.supabaseAnonKey);
}

export function hasSupabaseAdminConfig() {
  return Boolean(
    appConfig.supabaseUrl &&
      appConfig.supabaseAnonKey &&
      appConfig.supabaseServiceRoleKey,
  );
}

function numberFromEnv(key: string, fallback: number) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function emailListFromEnv(key: string) {
  return (process.env[key] || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}
