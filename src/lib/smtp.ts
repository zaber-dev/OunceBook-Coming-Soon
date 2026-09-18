import nodemailer from "nodemailer";

type MailContext = {
  transport: nodemailer.Transporter;
  from: string;
  replyTo?: string;
};

declare global {
  var _smtpContext: MailContext | undefined;
}

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://ouncebook.com").replace(/\/$/, "");

/** Inviter addresses are user-supplied and land inside HTML — escape them. */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildEmailShell(args: {
  preheader: string;
  title: string;
  summary: string;
  body: string[];
  actionLabel?: string;
  actionUrl?: string;
  footer: string[];
}) {
  const action =
    args.actionLabel && args.actionUrl
      ? `<p style="margin: 0 0 20px;"><a href="${args.actionUrl}" style="display: inline-block; padding: 11px 16px; border-radius: 10px; background: #111111; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600;">${args.actionLabel}</a></p>`
      : "";

  const bodyLines = args.body
    .map((line) => `<p style="margin: 0 0 12px; color: #202020; font-size: 14px; line-height: 1.6;">${line}</p>`)
    .join("");

  const footerLines = args.footer
    .map((line) => `<p style="margin: 0 0 8px; color: #666666; font-size: 12px; line-height: 1.5;">${line}</p>`)
    .join("");

  return `
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">
      ${args.preheader}
    </div>
    <div style="margin: 0; padding: 24px; background: #f3f3f3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 560px; margin: 0 auto; border: 1px solid #e1e1e1; border-radius: 14px; overflow: hidden; background: #ffffff;">
        <tr>
          <td style="padding: 18px 20px; border-bottom: 1px solid #ececec;">
            <p style="margin: 0; color: #111111; font-size: 15px; font-weight: 700; letter-spacing: 0.02em;">OunceBook</p>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px 20px 6px;">
            <h2 style="margin: 0 0 8px; color: #111111; font-size: 22px; line-height: 1.25;">${args.title}</h2>
            <p style="margin: 0 0 18px; color: #4b4b4b; font-size: 14px; line-height: 1.6;">${args.summary}</p>
            ${bodyLines}
            ${action}
          </td>
        </tr>
        <tr>
          <td style="padding: 2px 20px 20px; border-top: 1px solid #f0f0f0;">
            ${footerLines}
          </td>
        </tr>
      </table>
    </div>
  `;
}

function getSmtpContext() {
  if (global._smtpContext) {
    return global._smtpContext;
  }

  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const from = process.env.SMTP_FROM;

  if (!host || !portRaw || !from) {
    throw new Error("Missing SMTP config. Set SMTP_HOST, SMTP_PORT, and SMTP_FROM.");
  }

  const port = Number(portRaw);

  if (Number.isNaN(port)) {
    throw new Error("SMTP_PORT must be a number.");
  }

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: user && pass ? { user, pass } : undefined,
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
  });

  global._smtpContext = {
    transport,
    from,
    replyTo: process.env.SMTP_REPLY_TO,
  };

  return global._smtpContext;
}

export async function sendWaitlistVerificationEmail(args: {
  to: string;
  verificationUrl: string;
}) {
  const smtp = getSmtpContext();

  const text = [
    "Confirm your OunceBook waitlist request",
    "",
    "Thanks for joining the OunceBook waitlist.",
    "Please confirm this email to secure your place in line:",
    args.verificationUrl,
    "",
    "If you did not request this, you can ignore this email.",
    "",
    `OunceBook: ${SITE_URL}`,
  ].join("\n");

  const html = buildEmailShell({
    preheader: "Confirm your email to secure your OunceBook waitlist spot.",
    title: "Confirm your waitlist email",
    summary: "You are one click away from completing your OunceBook waitlist signup.",
    body: [
      "We only use this verification step to protect the waitlist from bots and mistyped addresses.",
      "Once confirmed, you will receive occasional launch updates and early access notices.",
    ],
    actionLabel: "Verify email",
    actionUrl: args.verificationUrl,
    footer: [
      "You received this email because this address was submitted to join the OunceBook waitlist.",
      "If this was not you, no action is needed.",
      `Questions? Reply to this email or visit ${SITE_URL}.`,
    ],
  });

  await smtp.transport.sendMail({
    from: smtp.from,
    to: args.to,
    replyTo: smtp.replyTo,
    subject: "Confirm your OunceBook waitlist signup",
    text,
    html,
    headers: {
      "List-Unsubscribe": `<mailto:hello@ouncebook.com?subject=Unsubscribe%20from%20waitlist%20emails>`,
    },
  });
}

export async function sendWaitlistWelcomeEmail(args: {
  to: string;
}) {
  const smtp = getSmtpContext();

  const text = [
    "You are on the OunceBook waitlist",
    "",
    "Your email has been verified and your waitlist spot is confirmed.",
    "We will only send occasional updates about major launch milestones and your invite status.",
    "",
    `Learn more: ${SITE_URL}`,
  ].join("\n");

  const html = buildEmailShell({
    preheader: "Your OunceBook waitlist spot is confirmed.",
    title: "Welcome to the OunceBook waitlist",
    summary: "Your email is verified and your spot is secured.",
    body: [
      "Thank you for joining early. We are rolling access out in controlled cohorts to keep quality high.",
      "We do not send noisy campaigns. You will hear from us only when there is meaningful progress.",
    ],
    actionLabel: "Visit OunceBook",
    actionUrl: SITE_URL,
    footer: [
      "This is a transactional confirmation email for your waitlist signup.",
      "If you need your data removed, contact hello@ouncebook.com from this same email address.",
    ],
  });

  await smtp.transport.sendMail({
    from: smtp.from,
    to: args.to,
    replyTo: smtp.replyTo,
    subject: "You are on the OunceBook waitlist",
    text,
    html,
    headers: {
      "List-Unsubscribe": `<mailto:hello@ouncebook.com?subject=Unsubscribe%20from%20waitlist%20emails>`,
    },
  });
}

/**
 * Sent to someone who is not on the waitlist, after a verified member named
 * them. One per pair, ever. The inviter's address is shown so the recipient can
 * recognise who vouched for them.
 */
export async function sendInvitationEmail(args: {
  to: string;
  inviterEmail: string;
  unsubscribeUrl: string;
}) {
  const smtp = getSmtpContext();
  const inviter = escapeHtml(args.inviterEmail);

  const html = buildEmailShell({
    preheader: `${inviter} wants to bring you to OunceBook.`,
    title: "Someone wants to bring you with them",
    summary: `${inviter} named you as someone they would bring to OunceBook.`,
    body: [
      "OunceBook is a social network with no feed. An AI reads what your friends wrote and catches you up on the few things worth knowing.",
      "We open in small groups of people who already know each other, so if you join the waitlist you will be brought in at the same time as the person who named you.",
      "If this is not something you want, ignore this email — we will not send another.",
    ],
    actionLabel: "Join the waitlist",
    actionUrl: `${SITE_URL}/`,
    footer: [
      `You received this once because ${inviter} entered your address when joining the OunceBook waitlist.`,
      `You are not subscribed to anything. <a href="${args.unsubscribeUrl}" style="color: #666666;">Never contact this address again</a>.`,
    ],
  });

  await smtp.transport.sendMail({
    from: smtp.from,
    to: args.to,
    replyTo: smtp.replyTo,
    subject: `${args.inviterEmail} wants to bring you to OunceBook`,
    html,
    headers: {
      "List-Unsubscribe": `<${args.unsubscribeUrl}>, <mailto:hello@ouncebook.com?subject=Unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
}

/**
 * Sent to someone already on the waitlist when another member names them.
 * `mutual` means they named each other — the signal we actually want, since it
 * is consented on both sides and forms the seed of a cluster.
 */
export async function sendNamedYouEmail(args: {
  to: string;
  inviterEmail: string;
  mutual: boolean;
}) {
  const smtp = getSmtpContext();
  const inviter = escapeHtml(args.inviterEmail);

  const body = args.mutual
    ? [
        `You named each other. When we open your group, you and ${inviter} will be brought in together.`,
        "Nothing else to do — we will email you both when it is your turn.",
      ]
    : [
        `${inviter} named you as someone they would bring when we open their group.`,
        "You are already on the waitlist, so there is nothing to do. We will let you know when your group opens.",
      ];

  const html = buildEmailShell({
    preheader: args.mutual
      ? "You both named each other."
      : `${inviter} named you.`,
    title: args.mutual ? "You both named each other" : "Someone named you",
    summary: args.mutual
      ? `You and ${inviter} each said you would bring the other.`
      : `${inviter} would bring you to OunceBook.`,
    body,
    footer: [
      "You are receiving this because you are on the OunceBook waitlist.",
      "Reply to this email if you would rather not hear about this again.",
    ],
  });

  await smtp.transport.sendMail({
    from: smtp.from,
    to: args.to,
    replyTo: smtp.replyTo,
    subject: args.mutual
      ? "You and someone else named each other"
      : `${args.inviterEmail} named you on OunceBook`,
    html,
    headers: {
      "List-Unsubscribe": `<mailto:hello@ouncebook.com?subject=Unsubscribe%20from%20waitlist%20emails>`,
    },
  });
}
