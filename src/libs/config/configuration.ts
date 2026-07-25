import * as process from 'node:process';

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || 'localhost',
  database: {
    type: process.env.DB_TYPE || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'secret',
    name: process.env.DB_NAME || 'postgres',
    synchronize: process.env.NODE_ENV !== 'production',
    autoLoadEntities: process.env.autoLoadEntities || true,
    logging: process.env.NODE_ENV !== 'production',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'secretKey',
    expiresIn: process.env.JWT_EXPIRES_IN || '60m',
  },
  otp_expire: parseInt(process.env.OTP_EXPIRE_MINUTES || '2', 10),
  sms: {
    provider: process.env.SMS_PROVIDER || 'asanak',
    baseUrl: process.env.SMS_BASE_URL || '',
    username: process.env.SMS_USERNAME || '',
    password: process.env.SMS_PASSWORD || '',
    source: process.env.SMS_SOURCE || '',
    apiKey: process.env.SMS_API_KEY || '',
    lineNumber: process.env.SMS_LINE_NUMBER || '',
  },
  s3: {
    region: process.env.S3_REGION || '',
    access_key: process.env.S3_ACCESS_KEY || '',
    secret_key: process.env.S3_SECRET_KEY || '',
    bucket_name: process.env.S3_BUCKET_NAME || '',
    public_url: process.env.S3_PUBLIC_URL || '',
    endpoint: process.env.S3_ENDPOINT || '',
  },
  // Soniox async speech-to-text (https://api.soniox.com)
  soniox: {
    apiKey: process.env.SONIOX_API_KEY || '',
  },
  // Gemini, used to clean up STT errors in a finished transcript. Either an
  // OpenRouter key or a Google AI Studio key is enough — OpenRouter wins when
  // both are present.
  llm: {
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    googleApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    // Optional override; defaults per provider (see GeminiService).
    refineModel: process.env.LLM_REFINE_MODEL || '',
    openrouterReferer: process.env.OPENROUTER_REFERER || 'https://korsi.ir',
    openrouterTitle: process.env.OPENROUTER_TITLE || 'Korsi Transcriber',
  },
  // pyannoteAI speaker diarization + voiceprint identification (https://api.pyannote.ai/v1)
  pyannote: {
    apiKey: process.env.PYANNOTE_API_KEY || '',
    enabled: process.env.ENABLE_PYANNOTE_DIARIZATION === 'true',
  },
  appName: process.env.APP_NAME || 'Transcriber',
});
