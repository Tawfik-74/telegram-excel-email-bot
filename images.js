'use strict';

const { randomUUID } = require('node:crypto');
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function downloadTelegramFile(ctx, fileId, maxBytes = 20 * 1024 * 1024) {
  const fileUrl = new URL(await ctx.telegram.getFileLink(fileId));
  if (fileUrl.protocol !== 'https:' || fileUrl.hostname !== 'api.telegram.org') throw new Error('DOWNLOAD_FAILED');
  const response = await fetch(fileUrl.href, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error('DOWNLOAD_FAILED');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('TOO_LARGE');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function downloadTelegramImage(ctx) {
  const photos = ctx.message.photo;
  const file = photos?.length ? photos.reduce((best, item) => item.width * item.height > best.width * best.height ? item : best) : ctx.message.document;
  let contentType = 'image/jpeg';
  if (!file) throw new Error('UNSUPPORTED_IMAGE');
  if (!photos?.length) {
    const name = file.file_name || '';
    if (/\.png$/i.test(name) && file.mime_type === 'image/png') contentType = 'image/png';
    else if (!(/\.jpe?g$/i.test(name) && file.mime_type === 'image/jpeg')) throw new Error('UNSUPPORTED_IMAGE');
  }
  if (file.file_size > MAX_IMAGE_BYTES) throw new Error('TOO_LARGE');
  const buffer = await downloadTelegramFile(ctx, file.file_id, MAX_IMAGE_BYTES);
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if ((contentType === 'image/png' && !png) || (contentType === 'image/jpeg' && !jpeg)) throw new Error('UNSUPPORTED_IMAGE');
  return { buffer, contentType, filename: contentType === 'image/png' ? 'oooha-design.png' : 'oooha-design.jpg', cid: `${randomUUID()}@oooha` };
}

module.exports = { MAX_IMAGE_BYTES, downloadTelegramFile, downloadTelegramImage };
