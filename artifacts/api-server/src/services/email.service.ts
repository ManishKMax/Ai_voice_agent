import nodemailer from "nodemailer";
import { platformSettings } from "../config/platform.config.js";
import { logger } from "../lib/logger.js";

function createTransport() {
  const { smtpHost, smtpPort, smtpUser, smtpPass } = platformSettings;
  if (!smtpHost || !smtpUser || !smtpPass) return null;

  const port = smtpPort || 587;
  return nodemailer.createTransport({
    host: smtpHost,
    port,
    secure: port === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });
}

function fromAddress() {
  return platformSettings.smtpFrom || platformSettings.smtpUser || "noreply@example.com";
}

export async function sendKycDecisionEmail(
  to: string,
  tenantName: string,
  decision: "approved" | "rejected",
  adminNotes?: string,
) {
  const transport = createTransport();
  if (!transport) {
    logger.warn({ to, decision }, "SMTP not configured — skipping KYC notification email");
    return;
  }

  const isApproved = decision === "approved";
  const subject = isApproved
    ? "Your account has been verified ✓"
    : "Update on your KYC submission";

  const notesBlock = adminNotes
    ? `<p style="margin:16px 0;padding:12px 16px;background:#f5f5f5;border-left:3px solid #d1d5db;border-radius:4px;font-size:14px;color:#374151;"><strong>Note from our team:</strong><br>${adminNotes}</p>`
    : "";

  const bodyContent = isApproved
    ? `<p style="margin:0 0 16px;">Your account has been <strong style="color:#16a34a;">approved</strong>. You can now log in to the portal and start using the AI voice agent platform.</p>
       <p style="margin:0 0 16px;">If you have any questions, reply to this email and our team will be happy to help.</p>`
    : `<p style="margin:0 0 16px;">Unfortunately your KYC submission was <strong style="color:#dc2626;">not approved</strong> at this time.</p>
       ${notesBlock}
       <p style="margin:0 0 16px;">Please review the feedback above, update your documents, and resubmit through the portal. Our team is here to help if you have questions.</p>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:40px 0;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
    <div style="background:${isApproved ? "#16a34a" : "#dc2626"};padding:24px 32px;">
      <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">${isApproved ? "Account Verified" : "KYC Submission Update"}</h1>
    </div>
    <div style="padding:32px;">
      <p style="margin:0 0 16px;color:#374151;">Hi ${tenantName},</p>
      ${bodyContent}
      <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">This is an automated message. Please do not reply directly to this email.</p>
    </div>
  </div>
</body>
</html>`;

  try {
    await transport.sendMail({ from: fromAddress(), to, subject, html });
    logger.info({ to, decision }, "KYC decision email sent");
  } catch (err) {
    logger.error({ err, to, decision }, "Failed to send KYC decision email");
  }
}

export async function sendTestEmail(to: string) {
  const transport = createTransport();
  if (!transport) {
    throw new Error("SMTP not configured. Fill in all SMTP fields and save first.");
  }

  await transport.sendMail({
    from: fromAddress(),
    to,
    subject: "Test email — Voice Agent Platform",
    html: `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:40px 0;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
    <div style="background:#2563eb;padding:24px 32px;">
      <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">SMTP connection working ✓</h1>
    </div>
    <div style="padding:32px;">
      <p style="margin:0 0 16px;color:#374151;">Your email configuration is set up correctly. KYC approval and rejection notifications will be sent from this address.</p>
    </div>
  </div>
</body>
</html>`,
  });
}
