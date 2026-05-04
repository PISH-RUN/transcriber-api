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
  appName: process.env.APP_NAME || 'Pishrun Project',
});
