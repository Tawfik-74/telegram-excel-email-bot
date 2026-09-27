'use strict';

const BRAND = 'OOOHA! - Social Sport';
const PLATFORMS = { INSTAGRAM_URL: 'Instagram', FACEBOOK_URL: 'Facebook', LINKEDIN_URL: 'LinkedIn', X_URL: 'X', WEBSITE_URL: 'Website' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function validateSocialUrl(value) {
  try {
    const url = new URL(value);
    const shorteners = ['bit.ly', 't.co', 'tinyurl.com', 'shorturl.at', 'ow.ly', 'buff.ly'];
    if (url.protocol !== 'https:' || url.username || url.password || shorteners.includes(url.hostname.toLowerCase())) return null;
    if ([...url.searchParams.keys()].some((key) => /^(utm_|fbclid$|gclid$|msclkid$)/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

function getConfiguredSocialLinks(env = process.env, warn = console.warn) {
  return Object.entries(PLATFORMS).flatMap(([key, name]) => {
    const value = env[key]?.trim();
    if (!value) return [];
    const url = validateSocialUrl(value);
    if (!url) { warn(`Ignoring ${key}: use a direct HTTPS URL without credentials or tracking parameters.`); return []; }
    return [{ name, url }];
  });
}

function buildPlainTextEmail({ message, socialLinks }) {
  return [message, BRAND, 'Connect with our community:', ...socialLinks.map(({ name, url }) => `${name}: ${url}`)].join('\n\n');
}

function buildEmailHtml({ message, image, socialLinks }) {
  const buttons = socialLinks.map(({ name, url }) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 14px;margin:4px;background:#172b28;color:#ffffff;text-decoration:none;border-radius:4px;font-size:14px;">${escapeHtml(name)}</a>`).join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f5f3;font-family:Arial,Helvetica,sans-serif;color:#172b28;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f3;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;">
<tr><td style="padding:28px 24px;background:#172b28;color:#ffffff;font-size:24px;font-weight:bold;">${BRAND}</td></tr>
<tr><td dir="auto" style="padding:28px 24px;font-size:16px;line-height:1.7;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(message).replace(/\r\n|\r|\n/g, '<br>')}</td></tr>
${image ? `<tr><td style="padding:0 24px 24px;"><img src="cid:${escapeHtml(image.cid)}" alt="OOOHA! Social Sport email design" width="552" style="display:block;width:100%;max-width:552px;height:auto;border:0;"></td></tr>` : ''}
<tr><td style="padding:24px;background:#e9efeb;font-size:13px;line-height:1.6;"><strong>${BRAND}</strong><br>Sport. Connection. Community.${buttons ? `<p style="margin:16px 0 0;">Connect with us</p>${buttons}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

function buildMailOptions(state, recipient, socialLinks, env = process.env) {
  const content = { message: state.message, image: state.image, socialLinks };
  const options = {
    from: env.EMAIL_FROM_NAME ? { name: env.EMAIL_FROM_NAME.replace(/[\r\n]/g, ''), address: env.GMAIL_USER } : env.GMAIL_USER,
    to: recipient,
    subject: env.EMAIL_SUBJECT || 'Message',
    text: buildPlainTextEmail(content),
    html: buildEmailHtml(content),
  };
  if (state.image) options.attachments = [{ filename: state.image.filename, content: state.image.buffer, cid: state.image.cid, contentType: state.image.contentType, contentDisposition: 'inline' }];
  return options;
}

module.exports = { escapeHtml, validateSocialUrl, getConfiguredSocialLinks, buildPlainTextEmail, buildEmailHtml, buildMailOptions };
