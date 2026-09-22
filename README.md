# Telegram Excel Email Bot

A Node.js Telegram bot that extracts email addresses from Excel files and sends controlled email batches through Gmail SMTP.

## Features

* Parses `.xlsx` files and extracts valid email addresses
* Removes duplicate addresses
* Limits each batch to 100 recipients
* Requires confirmation before sending
* Adds a 15–30 second delay between emails
* Reports progress every 10 emails
* Displays successful and failed delivery totals
* Restricts access using Telegram User IDs

## Technologies

* Node.js
* Telegraf
* Nodemailer
* XLSX
* dotenv

## Installation

```bash
git clone https://github.com/Tawfik-74/telegram-excel-email-bot.git
cd telegram-excel-email-bot
npm install
```

Create a `.env` file:

```env
BOT_TOKEN=your_telegram_bot_token
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=your_google_app_password
EMAIL_FROM_NAME=OOOHA! - Social Sport
EMAIL_SUBJECT=OOOHA! Update
ALLOWED_TELEGRAM_USER_IDS=123456789
```

Start the bot:

```bash
npm start
```

On Windows PowerShell:

```powershell
npm.cmd start
```

## Usage

1. Send `/start` to the bot.
2. Upload an Excel `.xlsx` file containing email addresses.
3. Enter the plain-text message.
4. Confirm the operation.
5. Monitor progress and review the final report.

Use `/cancel` to discard the current batch before sending.

## Security

Never commit the `.env` file, Telegram Bot Token, or Gmail App Password.

This project should only be used to contact recipients who have agreed to receive emails. Gmail is not intended for large-scale marketing campaigns.

## Author

Developed by [Tawfik-74](https://github.com/Tawfik-74).
