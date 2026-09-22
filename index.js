'use strict';

require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');

const REQUIRED_ENV = [
  'BOT_TOKEN',
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
];

const missingEnv = REQUIRED_ENV.filter(
  (key) => !process.env[key],
);

if (missingEnv.length > 0) {
  throw new Error(
    `Missing environment variables: ${missingEnv.join(', ')}`,
  );
}

const MAX_EMAILS_PER_BATCH = 100;
const MIN_DELAY_MS = 15_000;
const MAX_DELAY_MS = 30_000;

const STEPS = Object.freeze({
  WAITING_FOR_FILE: 'WAITING_FOR_FILE',
  WAITING_FOR_MESSAGE: 'WAITING_FOR_MESSAGE',
  WAITING_FOR_CONFIRMATION: 'WAITING_FOR_CONFIRMATION',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
});

const bot = new Telegraf(process.env.BOT_TOKEN);

const transporter = nodemailer.createTransport({
  service: 'gmail',

  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

const userStates = new Map();

let globalSendQueue = Promise.resolve();

const allowedUserIds = new Set(
  (process.env.ALLOWED_TELEGRAM_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);


function isAuthorized(ctx) {
  if (allowedUserIds.size === 0) {
    return true;
  }

  return allowedUserIds.has(String(ctx.from?.id));
}


function createInitialState() {
  return {
    step: STEPS.WAITING_FOR_FILE,
    emails: [],
    message: '',
    sourceCount: 0,
  };
}


function resetUser(userId) {
  const state = createInitialState();

  userStates.set(userId, state);

  return state;
}


function getUserState(userId) {
  return userStates.get(userId) || resetUser(userId);
}


function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}


function randomDelayMs() {
  return (
    Math.floor(
      Math.random() *
        (MAX_DELAY_MS - MIN_DELAY_MS + 1),
    ) + MIN_DELAY_MS
  );
}


function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}


function extractEmailsFromWorkbook(buffer) {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
  });

  const uniqueEmails = new Set();

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];

    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: false,
      defval: '',
    });

    for (const row of rows) {
      for (const cell of row) {

        const candidates = String(cell)
          .split(/[;,\s]+/)
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);

        for (const candidate of candidates) {
          if (isValidEmail(candidate)) {
            uniqueEmails.add(candidate);
          }
        }
      }
    }
  }

  return [...uniqueEmails];
}


async function downloadTelegramFile(ctx, fileId) {
  const fileUrl = await ctx.telegram.getFileLink(fileId);

  const response = await fetch(fileUrl.href);

  if (!response.ok) {
    throw new Error(
      `Telegram file download failed with HTTP ${response.status}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}


async function safeEditStatus(
  ctx,
  chatId,
  messageId,
  text,
) {
  try {
    await ctx.telegram.editMessageText(
      chatId,
      messageId,
      undefined,
      text,
    );
  } catch (error) {
    const errorMessage = String(
      error.description || error.message,
    );

   
    if (!errorMessage.includes('message is not modified')) {
      console.error(
        'Could not update Telegram status:',
        error.message,
      );
    }
  }
}


async function sendBatch(
  ctx,
  userId,
  statusMessage,
) {
  const state = getUserState(userId);

  state.step = STEPS.SENDING;

  const total = state.emails.length;

  let successful = 0;

  const failures = [];

  await safeEditStatus(
    ctx,
    ctx.chat.id,
    statusMessage.message_id,
    `Sending: 0/${total}...`,
  );

  for (let index = 0; index < total; index += 1) {
    const recipient = state.emails[index];

    try {
      let fromValue = process.env.GMAIL_USER;

      if (process.env.EMAIL_FROM_NAME) {
        const safeFromName =
          process.env.EMAIL_FROM_NAME.replace(
            /["\\]/g,
            '',
          );

        fromValue =
          `"${safeFromName}" <${process.env.GMAIL_USER}>`;
      }

      await transporter.sendMail({
        from: fromValue,
        to: recipient,
        subject:
          process.env.EMAIL_SUBJECT || 'Message',
        text: state.message,
      });

      successful += 1;
    } catch (error) {
      failures.push({
        email: recipient,
        reason: error.message,
      });

      console.error(
        `Failed to send to ${recipient}:`,
        error.message,
      );
    }

    const processed = index + 1;

    
    if (
      processed % 10 === 0 ||
      processed === total
    ) {
      await safeEditStatus(
        ctx,
        ctx.chat.id,
        statusMessage.message_id,
        `Sent/processed: ${processed}/${total}...`,
      );
    }

  
    if (processed < total) {
      const delay = randomDelayMs();

      console.log(
        `Waiting ${Math.round(delay / 1000)} seconds...`,
      );

      await sleep(delay);
    }
  }

  const failed = failures.length;

  
  const failedPreview = failures
    .slice(0, 10)
    .map(
      (item) =>
        `- ${item.email}: ${item.reason}`,
    )
    .join('\n');

  const report = [
    'Batch completed.',
    `Total processed: ${total}`,
    `Successful: ${successful}`,
    `Failed: ${failed}`,
    failedPreview
      ? `\nFailed recipients (up to 10):\n${failedPreview}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  await safeEditStatus(
    ctx,
    ctx.chat.id,
    statusMessage.message_id,
    report,
  );

  resetUser(userId);

  await ctx.reply(
    'Send another .xlsx file whenever you want to start a new batch.',
  );
}


bot.use(async (ctx, next) => {
  if (!isAuthorized(ctx)) {
    await ctx.reply(
      'You are not authorized to use this bot.',
    );

    return;
  }

  await next();
});


bot.start(async (ctx) => {
  resetUser(ctx.from.id);

  await ctx.reply(
    'Welcome. Upload an Excel (.xlsx) file containing email addresses.\n\n' +
      'Use /cancel at any time before sending to discard the current batch.',
  );
});


bot.command('cancel', async (ctx) => {
  const state = getUserState(ctx.from.id);

  if (state.step === STEPS.SENDING) {
    await ctx.reply(
      'The batch is already sending and cannot be cancelled safely.',
    );

    return;
  }

  resetUser(ctx.from.id);

  await ctx.reply(
    'Current batch cancelled. Upload a new .xlsx file to begin again.',
  );
});


bot.on('document', async (ctx) => {
  const state = getUserState(ctx.from.id);

  if (state.step !== STEPS.WAITING_FOR_FILE) {
    await ctx.reply(
      'I am not waiting for a file. Use /cancel first if you want to restart.',
    );

    return;
  }

  const document = ctx.message.document;

  const fileName =
    document.file_name?.toLowerCase() || '';

  if (!fileName.endsWith('.xlsx')) {
    await ctx.reply(
      'Please upload a valid .xlsx Excel file.',
    );

    return;
  }

  try {
    await ctx.reply(
      'Reading the Excel file...',
    );

    const buffer = await downloadTelegramFile(
      ctx,
      document.file_id,
    );

    const allEmails =
      extractEmailsFromWorkbook(buffer);

    if (allEmails.length === 0) {
      await ctx.reply(
        'No valid email addresses were found. Please check the file and try again.',
      );

      return;
    }

    state.sourceCount = allEmails.length;

    
    state.emails = allEmails.slice(
      0,
      MAX_EMAILS_PER_BATCH,
    );

    state.step = STEPS.WAITING_FOR_MESSAGE;

    let limitNotice = '';

    if (
      allEmails.length >
      MAX_EMAILS_PER_BATCH
    ) {
      limitNotice =
        `\nSafety limit applied: only the first ` +
        `${MAX_EMAILS_PER_BATCH} unique addresses ` +
        `will be processed.`;
    }

    await ctx.reply(
      `Found ${allEmails.length} valid unique email address(es).` +
        `${limitNotice}\n\n` +
        'Now send the plain-text message that should be emailed.',
    );
  } catch (error) {
    console.error(
      'Excel processing error:',
      error,
    );

    await ctx.reply(
      'I could not read that workbook. Make sure it is a valid .xlsx file and try again.',
    );
  }
});


bot.on('text', async (ctx) => {
  const state = getUserState(ctx.from.id);

  const text = ctx.message.text.trim();

 
  if (text.startsWith('/')) {
    return;
  }

  if (
    state.step !==
    STEPS.WAITING_FOR_MESSAGE
  ) {
    await ctx.reply(
      'Please upload an .xlsx file first, or use /cancel to restart.',
    );

    return;
  }

  if (!text) {
    await ctx.reply(
      'The email message cannot be empty. Please send plain text.',
    );

    return;
  }

  state.message = text;
  state.step =
    STEPS.WAITING_FOR_CONFIRMATION;

  await ctx.reply(
    `Ready to send to ${state.emails.length} recipient(s). Confirm?`,
    Markup.inlineKeyboard([
      Markup.button.callback(
        'Yes',
        'CONFIRM_SEND',
      ),
      Markup.button.callback(
        'No',
        'CANCEL_SEND',
      ),
    ]),
  );
});


bot.action('CANCEL_SEND', async (ctx) => {
  const state = getUserState(ctx.from.id);

  await ctx.answerCbQuery();

  if (
    state.step !==
    STEPS.WAITING_FOR_CONFIRMATION
  ) {
    await ctx.reply(
      'This confirmation is no longer active.',
    );

    return;
  }

  resetUser(ctx.from.id);

  await ctx.editMessageText(
    'Batch cancelled. Upload a new .xlsx file to begin again.',
  );
});


bot.action('CONFIRM_SEND', async (ctx) => {
  const userId = ctx.from.id;

  const state = getUserState(userId);

  await ctx.answerCbQuery();

  if (
    state.step !==
    STEPS.WAITING_FOR_CONFIRMATION
  ) {
    await ctx.reply(
      'This confirmation is no longer active.',
    );

    return;
  }

  state.step = STEPS.QUEUED;

  await ctx.editMessageText(
    'Confirmed. The batch has been added to the sending queue.',
  );

  const statusMessage = await ctx.reply(
    'Waiting for the sender...',
  );

 
  globalSendQueue = globalSendQueue
    .catch((error) => {
      console.error(
        'Previous queue job failed:',
        error,
      );
    })
    .then(() => {
      return sendBatch(
        ctx,
        userId,
        statusMessage,
      );
    })
    .catch(async (error) => {
      console.error(
        'Batch error:',
        error,
      );

      resetUser(userId);

      await safeEditStatus(
        ctx,
        ctx.chat.id,
        statusMessage.message_id,
        'The batch stopped because of an unexpected error. Check the server logs.',
      );
    });
});


bot.catch((error, ctx) => {
  console.error(
    `Unhandled bot error for update ${ctx.update.update_id}:`,
    error,
  );
});


async function main() {

  await transporter.verify();

  console.log(
    'Gmail SMTP connection verified.',
  );

  await bot.launch();

  console.log(
    'Telegram email bot is running.',
  );
}

main().catch((error) => {
  console.error(
    'Startup failed:',
    error,
  );

  process.exitCode = 1;
});


function shutdown(signal) {
  bot.stop(signal);
}

process.once('SIGINT', () => {
  shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});