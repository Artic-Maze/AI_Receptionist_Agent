try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment, as CI does.
}

const env = process.env;

function json(value, fallback) {
  if (!value) return fallback;
  return JSON.parse(value);
}

export const config = {
  port: Number(env.PORT ?? 3000),
  clinicName: env.CLINIC_NAME ?? 'Artic Maze Clinic',
  tz: env.CLINIC_TZ ?? 'Asia/Dhaka',
  databaseUrl: env.DATABASE_URL,
  testDatabaseUrl: env.TEST_DATABASE_URL,
  llm: {
    model: env.LLM_MODEL ?? 'claude-opus-5-5',
    effort: env.LLM_EFFORT ?? 'medium',
  },
  judgeModel: env.JUDGE_MODEL ?? env.LLM_MODEL ?? 'claude-opus-5-5',
  calendar: {
    adapter: env.CALENDAR_ADAPTER ?? 'fake',
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
    secret: env.VAPI_SECRET,
  },
};
