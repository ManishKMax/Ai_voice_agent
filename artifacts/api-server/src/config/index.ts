export const config = {
  port: parseInt(process.env.PORT ?? "8080", 10),
  jwtSecret: process.env.JWT_SECRET ?? "changeme",
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    phoneNumber: process.env.TWILIO_PHONE_NUMBER ?? "",
  },
  sarvam: {
    apiKey: process.env.SARVAM_API_KEY ?? "",
  },
  baseUrl: process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : process.env.REPLIT_DOMAINS
    ? `https://${process.env.REPLIT_DOMAINS.split(",")[0].trim()}`
    : `http://localhost:8080`,
};
