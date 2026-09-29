# Telegram Excel Email Bot

Node.js 18+ bot using Telegraf, Nodemailer, XLSX and dotenv. Existing Gmail SMTP sending now includes responsive, table-based OOOHA! - Social Sport HTML emails and a plain-text fallback.

## Setup

Run `npm ci`. On a new installation only, create `.env` from `.env.example` and fill in credentials locally. Never commit `.env`. Existing installations should retain their current `.env`.

Required: `BOT_TOKEN`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` (a Gmail App Password). Optional: `EMAIL_FROM_NAME`, `EMAIL_SUBJECT`, and comma-separated `ALLOWED_TELEGRAM_USER_IDS`. An empty allowlist preserves the original behavior: anyone can use the bot, so configure it for a private deployment.

Optional social settings: `INSTAGRAM_URL`, `FACEBOOK_URL`, `LINKEDIN_URL`, `X_URL`, `WEBSITE_URL`. Only valid direct HTTPS URLs appear in the email and confirmation; empty entries are hidden. Invalid entries produce a warning naming the variable only. Known shorteners and common tracking parameters are rejected; use direct destination links without tracking. No extra dependencies are required.

Run `npm run check`, `npm test`, then `npm start`. SMTP verification must succeed before Telegram polling starts. TLS certificate validation remains enabled; resolve certificate trust issues in the host environment.

## Flow

1. Send `/start`, then an `.xlsx` workbook. All sheets are scanned; valid addresses are deduplicated and limited to the first 100.
2. Enter the **Subject** in its own reply field (one non-empty line, up to 200 characters). Then enter the **Message** in a separate reply field; paragraphs and line breaks are supported. The subject belongs to this batch and overrides `EMAIL_SUBJECT`. HTML entered in the message is escaped, never executed.
3. Select **Add Image** or **Skip Image**. Photos and PNG/JPEG documents are supported, up to **5 MiB (5,242,880 bytes)**. Document extension, MIME type and file signature must agree. The largest photo variant is used.
4. Review recipient count, subject, a message preview, image status and enabled social platforms, then select **Send** or **Cancel**. The preview is shortened for long messages; the full message is emailed.
5. Emails are sent individually through one queue, with randomized 15–30 second delays, progress every 10 recipients and a final success/failure report.

Images are inline CID attachments held temporarily in memory. No uploaded image is saved to disk. Both HTML and text bodies include the message and branding; configured social URLs also appear in text. The HTML remains readable with images blocked. Tables, inline CSS and visible platform names support common email clients without external icon images.

`/cancel` discards any batch before sending, including queued batches. A sending batch cannot be cancelled. `/start` cannot replace a queued or sending batch. Image buffers are released on cancellation, completion or fatal failure. Old buttons cannot affect a new batch. State is in memory: a process restart discards pending work, and no delivery history is persisted. Do not restart during a batch without reviewing which recipients already received it. The 5 MiB limit applies per image, not to aggregate memory across users; use the allowlist to bound users. Excel downloads are capped at 20 MiB. File signatures are checked, but images are not fully decoded or re-encoded.

## Consent and delivery

Send only to recipients who consented. For marketing mail, provide and honor an unsubscribe method in your message; this bot does not implement subscription management. Do not send image-only content. There are no tracking pixels, deceptive headers or spam-filter bypasses. HTML and pacing do not guarantee inbox placement. Configure domain authentication where applicable.

## Verification

`npm test` uses simulated Telegram/SMTP requests and exercises the flows, image validation, cancellation, stale buttons, HTML escaping, recipient isolation, failures, progress, pacing and startup. It sends no real emails and does not use real credentials.

Before a larger batch, use a workbook with one controlled recipient and verify in Gmail: the image appears inline, text remains readable with images blocked, social buttons open the configured destinations, and **Show original** includes both text/plain and text/html plus the matching Content-ID. Test both photo upload and PNG/JPEG document upload through Telegram. Check mobile rendering and repeat with Skip Image. Live Gmail display requires manual verification; automated MIME checks cannot confirm it.
