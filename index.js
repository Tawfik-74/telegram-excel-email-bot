'use strict';

require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });

const { Telegraf, Markup } = require('telegraf');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
const { randomUUID } = require('node:crypto');
const { buildMailOptions, getConfiguredSocialLinks } = require('./email');
const { downloadTelegramFile, downloadTelegramImage } = require('./images');
const socialLinks = getConfiguredSocialLinks();
const errorCode = (error) => ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EENVELOPE', 'EMESSAGE'].includes(error?.code) ? error.code : 'REQUEST_FAILED';

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
  WAITING_FOR_IMAGE_CHOICE: 'WAITING_FOR_IMAGE_CHOICE',
  WAITING_FOR_IMAGE: 'WAITING_FOR_IMAGE',
  WAITING_FOR_CONFIRMATION: 'WAITING_FOR_CONFIRMATION',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
});

const bot = new Telegraf(process.env.BOT_TOKEN);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,

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
    image: null,
    id: randomUUID(),
    busy: false,
  };
}


function clearUserState(userId) {
  const previous = userStates.get(userId);
  if (previous) { previous.image = null; previous.emails = []; previous.message = ''; }
  userStates.delete(userId);
}

function resetUser(userId) {
  clearUserState(userId);
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
        errorCode(error),
      );
    }
  }
}


async function sendBatch(
  ctx,
  userId,
  statusMessage,
  state,
) {
  if (userStates.get(userId) !== state || state.step !== STEPS.QUEUED) return;

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
      // Send only to recipients who consented to receive these emails.
      await transporter.sendMail(buildMailOptions(state, recipient, socialLinks));
      successful += 1;
    } catch (error) {
      failures.push({
        email: recipient,
        reason: errorCode(error),
      });

      console.error(
        'Recipient delivery failed:',
        errorCode(error),
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

  clearUserState(userId);

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

  if (!ctx.from) return;
  const active = userStates.get(ctx.from.id);
  if (active && active.chatId != null && active.chatId !== ctx.chat?.id) {
    await ctx.reply('Continue your active batch in the chat where it was started.');
    return;
  }
  await next();
});


bot.start(async (ctx) => {
  const current = userStates.get(ctx.from.id);
  if (current && [STEPS.QUEUED, STEPS.SENDING].includes(current.step)) {
    return ctx.reply('Your batch is queued or sending. Use /cancel while queued; wait for completion while sending.');
  }
  resetUser(ctx.from.id).chatId = ctx.chat.id;

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

  clearUserState(ctx.from.id);

  await ctx.reply(
    'Current batch cancelled. Upload a new .xlsx file to begin again.',
  );
});


bot.on('document', async (ctx) => {
  const state = getUserState(ctx.from.id);
  state.chatId ??= ctx.chat.id;
  if (state.step === STEPS.WAITING_FOR_IMAGE) return receiveImage(ctx);
  if (state.busy) return ctx.reply('Please wait for the current file to finish downloading.');

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

  state.busy = true;
  try {
    await ctx.reply(
      'Reading the Excel file...',
    );

    const buffer = await downloadTelegramFile(
      ctx,
      document.file_id,
    );

    if (userStates.get(ctx.from.id) !== state) return;
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
      errorCode(error),
    );

    await ctx.reply(
      'I could not read that workbook. Make sure it is a valid .xlsx file and try again.',
    );
  } finally { state.busy = false; }
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
      state.step === STEPS.WAITING_FOR_IMAGE ? 'Please upload a PNG/JPEG photo or document, or use /cancel.' : 'Follow the current step using the buttons, or use /cancel to restart.',
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
  state.step = STEPS.WAITING_FOR_IMAGE_CHOICE;
  await ctx.reply('Would you like to add an image/design?', keyboard(state, [['Add Image', 'ADD_IMAGE'], ['Skip Image', 'SKIP_IMAGE'], ['Cancel', 'CANCEL_SEND']]));
});

function keyboard(state, actions) {
  return Markup.inlineKeyboard(actions.map(([label, action]) => Markup.button.callback(label, action + ':' + state.id)));
}

async function showConfirmation(ctx, state) {
  state.step = STEPS.WAITING_FOR_CONFIRMATION;
  await ctx.reply([
    'Ready to send', '',
    'Recipients: ' + state.emails.length,
    'Subject: ' + (process.env.EMAIL_SUBJECT || 'Message'),
    'Image: ' + (state.image ? 'Included' : 'Not included'),
    'Social links: ' + (socialLinks.map((link) => link.name).join(', ') || 'None'),
  ].join('\n'), keyboard(state, [['Send', 'CONFIRM_SEND'], ['Cancel', 'CANCEL_SEND']]));
}

async function receiveImage(ctx) {
  const state = userStates.get(ctx.from.id);
  if (!state || state.step !== STEPS.WAITING_FOR_IMAGE) return ctx.reply('Choose Add Image after entering your message first.');
  if (state.busy) return ctx.reply('Please wait for the current image to finish downloading.');
  state.busy = true;
  try {
    const image = await downloadTelegramImage(ctx);
    if (userStates.get(ctx.from.id) !== state) return;
    state.image = image;
    await showConfirmation(ctx, state);
  } catch (error) {
    if (userStates.get(ctx.from.id) !== state) return;
    state.image = null;
    state.step = STEPS.WAITING_FOR_IMAGE;
    const messages = { TOO_LARGE: 'Image exceeds the 5 MB limit. Upload a smaller image.', UNSUPPORTED_IMAGE: 'Unsupported image. Send a PNG or JPEG photo/document with a matching filename and MIME type.' };
    await ctx.reply(messages[error.message] || 'Could not download the image. Please try again or use /cancel.');
  } finally { state.busy = false; }
}

bot.on('photo', receiveImage);

bot.on('callback_query', async (ctx) => {
  const [action, id] = (ctx.callbackQuery.data || '').split(':');
  const state = userStates.get(ctx.from.id);
  const validSteps = {
    ADD_IMAGE: [STEPS.WAITING_FOR_IMAGE_CHOICE],
    SKIP_IMAGE: [STEPS.WAITING_FOR_IMAGE_CHOICE],
    CANCEL_SEND: [STEPS.WAITING_FOR_IMAGE_CHOICE, STEPS.WAITING_FOR_IMAGE, STEPS.WAITING_FOR_CONFIRMATION],
    CONFIRM_SEND: [STEPS.WAITING_FOR_CONFIRMATION],
  };
  if (!state || state.id !== id || !validSteps[action]?.includes(state.step) || state.busy) {
    return ctx.answerCbQuery('This action is no longer active. Follow the current step or use /start.');
  }
  // Change state before any await, so double clicks cannot enqueue a second job.
  if (action === 'CANCEL_SEND') {
    clearUserState(ctx.from.id);
    await ctx.answerCbQuery();
    return ctx.editMessageText('Batch cancelled. Upload a new .xlsx file to begin again.');
  }
  if (action === 'ADD_IMAGE') {
    state.step = STEPS.WAITING_FOR_IMAGE;
    await ctx.answerCbQuery();
    return ctx.editMessageText('Upload a PNG or JPEG photo/document, up to 5 MB. Use /cancel to discard this batch.');
  }
  if (action === 'SKIP_IMAGE') {
    state.step = STEPS.WAITING_FOR_CONFIRMATION;
    await ctx.answerCbQuery();
    return showConfirmation(ctx, state);
  }
  state.step = STEPS.QUEUED;
  await ctx.answerCbQuery();
  await ctx.editMessageText('Confirmed. The batch has been added to the sending queue.');
  const statusMessage = await ctx.reply('Waiting for the sender... Use /cancel before sending starts to cancel.');
  const userId = ctx.from.id;
  globalSendQueue = globalSendQueue.catch(() => {}).then(async () => {
    try {
      await sendBatch(ctx, userId, statusMessage, state);
    } catch (error) {
      console.error('Batch error:', errorCode(error));
      if (userStates.get(userId) === state) clearUserState(userId);
      await safeEditStatus(ctx, ctx.chat.id, statusMessage.message_id, 'The batch stopped because of an unexpected error. Start again with /start.');
    }
  });
});

bot.catch(async (error, ctx) => {
  console.error('Bot request failed:', errorCode(error));
  const state = userStates.get(ctx.from?.id);
  if (state?.step !== STEPS.SENDING) clearUserState(ctx.from?.id);
  await ctx.reply('An unexpected error occurred. Use /start to restart, or wait if your batch is already sending.').catch(() => {});
});


async function main() {

  await transporter.verify();

  console.log(
    'Gmail SMTP connection verified.',
  );

  await bot.launch({}, () => console.log('Telegram email bot is running.'));
}

if (require.main === module) main().catch((error) => {
  console.error(
    'Startup failed:',
    errorCode(error),
  );

  process.exitCode = 1;
});


function shutdown(signal) {
  try { bot.stop(signal); } catch {}
  transporter.close();
  for (const userId of userStates.keys()) clearUserState(userId);
}

process.once('SIGINT', () => {
  shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});
module.exports = { bot, transporter, main, userStates, STEPS, clearUserState, extractEmailsFromWorkbook, sendBatch, randomDelayMs, getQueue: () => globalSendQueue };
