import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

let _transporter: Transporter | null = null;

async function getTransporter(): Promise<Transporter | null> {
  if (_transporter) return _transporter;

  const smtpHost = process.env.SMTP_HOST;

  if (!smtpHost) {
    // Modo dev sin SMTP — el OTP se imprime en consola, no se envía email
    return null;
  }

  // Producción / staging — Resend SMTP relay u otro proveedor SMTP
  _transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: Number(process.env.SMTP_PORT ?? 465) === 465,
    auth: {
      user: process.env.SMTP_USER ?? 'resend',
      pass: process.env.SMTP_PASSWORD ?? '',
    },
  });

  return _transporter;
}

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  const transporter = await getTransporter();

  // Modo dev: sin SMTP configurado → OTP al log del servidor
  if (!transporter) {
    console.log('');
    console.log('┌─────────────────────────────────────────┐');
    console.log('│         🔑  OTP DEV MODE                │');
    console.log(`│  Email : ${to.padEnd(31)}│`);
    console.log(`│  Código: ${otp.padEnd(31)}│`);
    console.log('│  (Configura SMTP_HOST para producción)  │');
    console.log('└─────────────────────────────────────────┘');
    console.log('');
    return;
  }

  const from = process.env.EMAIL_FROM ?? 'no-reply@playflow.app';
  const fromName = process.env.EMAIL_FROM_NAME ?? 'PlayFlow';
  const ttlMinutes = Number(process.env.OTP_TTL_MINUTES ?? 10);

  try {
    const info = await transporter.sendMail({
      from: `"${fromName}" <${from}>`,
      to,
      subject: 'Tu código de acceso PlayFlow',
      text: [
        `Tu código de acceso es: ${otp}`,
        ``,
        `Este código expira en ${ttlMinutes} minutos.`,
        `No compartas este código con nadie.`,
        ``,
        `Si no solicitaste este código, puedes ignorar este mensaje.`,
      ].join('\n'),
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h2 style="margin: 0 0 24px; font-size: 20px; color: #111;">Tu código de acceso</h2>
          <div style="
            font-size: 40px;
            font-weight: bold;
            letter-spacing: 10px;
            text-align: center;
            padding: 24px;
            background: #f5f5f5;
            border-radius: 8px;
            margin-bottom: 24px;
            color: #111;
          ">${otp}</div>
          <p style="color: #555; font-size: 14px; margin: 0 0 8px;">
            Este código expira en <strong>${ttlMinutes} minutos</strong>.
          </p>
          <p style="color: #555; font-size: 14px; margin: 0 0 8px;">
            No compartas este código con nadie.
          </p>
          <p style="color: #999; font-size: 12px; margin: 24px 0 0;">
            Si no solicitaste este código, puedes ignorar este mensaje.
          </p>
        </div>
      `,
    });

    // En dev con Ethereal, mostrar la URL de preview en consola
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`[EmailService] Preview OTP para ${to}: ${previewUrl}`);
    }
    console.log(`[EmailService] OTP aceptado por SMTP para ${to} (messageId=${info.messageId ?? 'unknown'})`);
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }

    console.warn('[EmailService] SMTP error en dev, fallback a OTP en consola:', error);
    console.log('');
    console.log('┌─────────────────────────────────────────┐');
    console.log('│    🔑 OTP DEV FALLBACK (SMTP ERROR)     │');
    console.log(`│  Email : ${to.padEnd(31)}│`);
    console.log(`│  Código: ${otp.padEnd(31)}│`);
    console.log('└─────────────────────────────────────────┘');
    console.log('');
  }
}
