const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.');
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return transporter;
}

async function sendPasswordResetCode(email, code) {
  const mailer = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appName = process.env.APP_NAME || 'FLUPY';

  await mailer.sendMail({
    from,
    to: email,
    subject: `${appName} password reset code`,
    text: `Your password reset verification code is: ${code}\n\nThis code expires in 10 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.4;">
        <h2>${appName} Password Reset</h2>
        <p>Your verification code is:</p>
        <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px;">${code}</p>
        <p>This code expires in 10 minutes.</p>
      </div>
    `,
  });
}

module.exports = {
  sendPasswordResetCode,
};
