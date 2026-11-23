try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const env = process.env;

function json(value, fallback) {
  if (!value) return fallback;
  return JSON.parse(value);
}

export const config = {
  port: Number(env.PORT ?? 3000),
  /**
   * The addresses a proxy in front of the app connects from, comma-separated: IPs,
   * CIDR ranges, or "loopback", "linklocal" or "uniquelocal". Behind Traefik in Docker
   * that is "uniquelocal" (the private ranges). The rate limits key on the visitor's
   * address, which is then read from X-Forwarded-For, right to left, stopping at the
   * first address not on this list. Unset, the header is ignored.
   */
  trustProxy: env.TRUST_PROXY || false,
  clinicName: env.CLINIC_NAME ?? 'Artic Maze Clinic',
  tz: env.CLINIC_TZ ?? 'Asia/Dhaka',
  databaseUrl: env.DATABASE_URL,
  testDatabaseUrl: env.TEST_DATABASE_URL,
  llm: {
    model: env.LLM_MODEL ?? 'claude-opus-5-5',
    effort: env.LLM_EFFORT ?? 'medium',
    /** On calls the caller hears silence while the model thinks, so it thinks less. */
    voiceEffort: env.LLM_VOICE_EFFORT || 'low',
  },
  /** Where Vapi reaches this server: https, public, no trailing slash. */
  publicUrl: env.PUBLIC_URL?.replace(/\/+$/, ''),
  judgeModel: env.JUDGE_MODEL ?? env.LLM_MODEL ?? 'claude-opus-5-5',
  calendar: {
    /** db: the demo calendar in Postgres. calcom: the real Cal.com API. */
    adapter: env.CALENDAR_ADAPTER ?? 'db',
    calcom: {
      apiKey: env.CALCOM_API_KEY,
      baseUrl: env.CALCOM_BASE_URL ?? 'https://api.cal.com/v2',
      providers: json(env.CALCOM_PROVIDERS, []),
      attendeeEmailDomain: env.CALCOM_ATTENDEE_EMAIL_DOMAIN ?? 'patients.example.com',
    },
  },
  whatsapp: {
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    appSecret: env.WHATSAPP_APP_SECRET,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: env.WHATSAPP_API_VERSION ?? 'v23.0',
  },
  vapi: {
    /** Shared with Vapi, which sends it on every request to this server. */
    secret: env.VAPI_SECRET,
    /** Private key, only for `npm run vapi:assistant -- --push`. */
    apiKey: env.VAPI_API_KEY,
    /** Both public: the homepage needs them to start a call in the browser. */
    publicKey: env.VAPI_PUBLIC_KEY,
    assistantId: env.VAPI_ASSISTANT_ID,
  },
};
