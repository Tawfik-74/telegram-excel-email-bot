'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
process.env.BOT_TOKEN = '123456:test-token';
process.env.GMAIL_USER = 'sender@example.com';
process.env.GMAIL_APP_PASSWORD = 'test-password';
process.env.ALLOWED_TELEGRAM_USER_IDS = '1,2';
process.env.EMAIL_SUBJECT = 'Test subject';
process.env.EMAIL_FROM_NAME = 'OOOHA! - Social Sport';
for (const key of ['INSTAGRAM_URL','FACEBOOK_URL','LINKEDIN_URL','X_URL','WEBSITE_URL']) process.env[key] = '';
const app = require('./index');
const email = require('./email');
const images = require('./images');
const nodemailer = require('nodemailer');

test('email bot regression and enhancement scenarios', async (t) => {
  const calls = [], sent = [], delays = [];
  let sequence = 10, bytes, failAt = -1, attempts = 0;
  const originalApi = app.bot.telegram.constructor.prototype.callApi;
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalSend = app.transporter.sendMail;
  app.bot.botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot' };
  app.bot.telegram.constructor.prototype.callApi = async function(method, payload) {
    calls.push({method, ...payload});
    if (method === 'getFile') return {file_path:'test/image', file_id:payload.file_id};
    return {message_id: ++sequence, chat: {id: payload.chat_id || 1}};
  };
  global.fetch = async () => new Response(bytes);
  global.setTimeout = (fn, ms, ...args) => {
    if (ms >= 15000 && ms <= 30000) { delays.push(ms); return originalTimeout(fn, 0, ...args); }
    return originalTimeout(fn, ms, ...args);
  };
  app.transporter.sendMail = async (options) => {
    sent.push(options);
    if (attempts++ === failAt) throw Object.assign(new Error('private diagnostic'), {code:'EENVELOPE'});
    return {accepted:[options.to]};
  };
  function workbook(count = 1) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Email'], ...Array.from({length:count}, (_, i) => [`user${i}@example.com`]), ['USER0@example.com; invalid']]));
    return XLSX.write(book, {type:'buffer', bookType:'xlsx'});
  }
  async function message(data, user = 1) {
    const msg = {message_id:++sequence,date:1,chat:{id:user,type:'private'},from:{id:user,is_bot:false,first_name:'Test'},...data};
    if (data.text?.startsWith('/')) msg.entities=[{offset:0,length:data.text.length,type:'bot_command'}];
    await app.bot.handleUpdate({update_id:++sequence,message:msg});
  }
  async function action(name, user = 1, id = app.userStates.get(user)?.id) {
    await app.bot.handleUpdate({update_id:++sequence,callback_query:{id:String(sequence),from:{id:user,is_bot:false,first_name:'Test'},chat_instance:'test',data:`${name}:${id}`,message:{message_id:1,date:1,chat:{id:user,type:'private'}}}});
  }
  async function prepare(count=1, user=1) {
    await message({text:'/start'},user);
    bytes=workbook(count);
    await message({document:{file_id:'sheet',file_name:'list.xlsx'}},user);
    assert.equal(app.userStates.get(user).step, app.STEPS.WAITING_FOR_SUBJECT);
    assert.equal(calls.at(-1).reply_markup.input_field_placeholder,'Enter the email subject');
    await message({text:'Custom campaign subject ' + user},user);
    assert.equal(app.userStates.get(user).step, app.STEPS.WAITING_FOR_MESSAGE);
    assert.equal(calls.at(-1).reply_markup.input_field_placeholder,'Enter the email message');
    await message({text:'Hello <script>alert("x")</script> & friends\nSecond line'},user);
    assert.equal(app.userStates.get(user).step,app.STEPS.WAITING_FOR_IMAGE_CHOICE);
  }
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7V8AAAAASUVORK5CYII=', 'base64');
  const jpeg=Buffer.from([255,216,255,224,0,16,255,217]);
  try {
    await t.test('Excel + text + no image; single recipient; escaped HTML and fallback',async()=>{
      await prepare(); await action('SKIP_IMAGE');
      assert.equal(app.userStates.get(1).image,null);
      await action('CONFIRM_SEND'); await app.getQueue();
      assert.equal(sent.length,1); assert.equal(sent[0].to,'user0@example.com');
      assert.equal(sent[0].subject,'Custom campaign subject 1');
      assert.ok(!sent[0].text.includes('Custom campaign subject 1'));
      assert.equal(sent[0].attachments,undefined); assert.ok(!sent[0].html.includes('<img'));
      assert.ok(sent[0].html.includes('&lt;script&gt;')); assert.ok(sent[0].html.includes('<br>Second line'));
      assert.ok(sent[0].text.includes('<script>')); assert.ok(!app.userStates.has(1));
    });
    await t.test('Telegram highest-resolution photo and inline CID',async()=>{
      await prepare();await action('ADD_IMAGE');bytes=jpeg;
      await message({photo:[{file_id:'large',width:100,height:100,file_size:8},{file_id:'small',width:10,height:10,file_size:8}]});
      assert.equal(calls.filter(c=>c.method==='getFile').at(-1).file_id,'large');
      await action('CONFIRM_SEND');await app.getQueue();
      const mail=sent.at(-1); assert.equal(mail.attachments[0].contentType,'image/jpeg');
      assert.ok(mail.html.includes(`cid:${mail.attachments[0].cid}`));
    });
    await t.test('PNG document, MIME composition, cancellation before confirmation clears image',async()=>{
      await prepare();await action('ADD_IMAGE');bytes=png;
      await message({document:{file_id:'png',file_name:'DESIGN.PNG',mime_type:'image/png',file_size:png.length}});
      const state=app.userStates.get(1);assert.equal(state.step,app.STEPS.WAITING_FOR_CONFIRMATION);
      const options=email.buildMailOptions(state,'controlled@example.com',[]);
      const mime=await nodemailer.createTransport({streamTransport:true,buffer:true}).sendMail(options);
      const raw=mime.message.toString();
      for(const part of ['multipart/alternative','text/plain','text/html','Content-ID: <'+state.image.cid+'>']) assert.ok(raw.includes(part));
      await message({text:'/cancel'});assert.equal(state.image,null);assert.ok(!app.userStates.has(1));
    });
    await t.test('JPEG document and duplicate confirmation send exactly once',async()=>{
      await prepare();await action('ADD_IMAGE');bytes=jpeg;
      await message({document:{file_id:'jpg',file_name:'design.jpg',mime_type:'image/jpeg',file_size:jpeg.length}});
      const state=app.userStates.get(1), offset=sent.length;
      assert.equal(state.image.contentType,'image/jpeg');
      const summary=calls.filter(c=>c.method==='sendMessage').at(-1).text;
      for(const value of ['Recipients: 1','Subject: Custom campaign subject 1','Message preview:','Hello <script>','Image: Included','Social links: None']) assert.ok(summary.includes(value));
      await Promise.all([action('CONFIRM_SEND',1,state.id),action('CONFIRM_SEND',1,state.id)]);
      await app.getQueue();assert.equal(sent.length-offset,1);assert.equal(state.image,null);
    });
    await t.test('unsupported types, MIME mismatch, oversized metadata and streamed body, wrong-step text',async()=>{
      await prepare(); await action('ADD_IMAGE');
      for(const doc of [{file_name:'bad.svg',mime_type:'image/svg+xml'}, {file_name:'bad.png',mime_type:'image/jpeg'}, {file_name:'big.png',mime_type:'image/png',file_size:images.MAX_IMAGE_BYTES+1}]) {
        await message({document:{file_id:'bad',...doc}});assert.equal(app.userStates.get(1).step,app.STEPS.WAITING_FOR_IMAGE);
      }
      bytes=Buffer.alloc(images.MAX_IMAGE_BYTES+1);
      await message({document:{file_id:'big',file_name:'big.png',mime_type:'image/png'}});
      assert.ok(calls.at(-1).text.includes('5 MB'));
      bytes=Buffer.from('fake png');
      await message({document:{file_id:'fake',file_name:'fake.png',mime_type:'image/png'}});
      assert.ok(calls.at(-1).text.includes('Unsupported'));
      await message({text:'not an image'});assert.ok(calls.at(-1).text.includes('PNG/JPEG'));
      await message({text:'/cancel'});assert.ok(!app.userStates.has(1));
      await message({photo:[{file_id:'wrong',width:1,height:1}]});assert.ok(calls.at(-1).text.includes('Choose Add Image'));
    });
    await t.test('download failure and cancellation during download discard late image',async()=>{
      await prepare();await action('ADD_IMAGE');
      global.fetch=async()=>{throw new Error('secret URL');};
      await message({photo:[{file_id:'x',width:1,height:1}]});assert.ok(calls.at(-1).text.includes('Could not download'));
      let release;global.fetch=()=>new Promise(resolve=>{release=resolve;});
      const pending=message({photo:[{file_id:'x',width:1,height:1}]});
      while(!release) await new Promise(resolve=>setImmediate(resolve));
      const old=app.userStates.get(1);await message({text:'/cancel'});release(new Response(jpeg));await pending;
      assert.equal(old.image,null);assert.ok(!app.userStates.has(1));global.fetch=async()=>new Response(bytes);
    });
    await t.test('social configuration: empty, invalid, one valid platform, escaped URLs',()=>{
      const warnings=[];
      assert.deepEqual(email.getConfiguredSocialLinks({}),[]);
      const links=email.getConfiguredSocialLinks({INSTAGRAM_URL:'https://instagram.com/oooha',X_URL:'javascript:secret',WEBSITE_URL:'https://bit.ly/test'},v=>warnings.push(v));
      assert.equal(links.length,1);assert.equal(links[0].name,'Instagram');assert.equal(warnings.length,2);assert.ok(!warnings.join('').includes('javascript:secret'));
      assert.equal(email.validateSocialUrl('https://user:secret@example.com'),null);
      assert.equal(email.validateSocialUrl('https://example.com/?utm_source=x'),null);
      assert.ok(email.buildEmailHtml({message:'hello',socialLinks:links}).includes('https://instagram.com/oooha'));
      assert.ok(email.buildPlainTextEmail({message:'hello',socialLinks:links}).includes(links[0].url));
    });
    await t.test('100-recipient cap, every-10 progress, failure isolation and pacing',async()=>{
      await prepare(105);assert.equal(app.userStates.get(1).emails.length,100);
      await action('SKIP_IMAGE');const offset=calls.length;const sentOffset=sent.length;failAt=attempts+1;
      await action('CONFIRM_SEND');await app.getQueue();
      assert.equal(sent.length-sentOffset,100);
      const progress=calls.slice(offset).filter(c=>c.text?.startsWith('Sent/processed:'));
      assert.equal(progress.length,10);assert.equal(progress[0].text,'Sent/processed: 10/100...');
      assert.ok(calls.some(c=>c.text?.includes('Successful: 99\nFailed: 1')));
      assert.equal(delays.length,99);assert.ok(delays.every(ms=>ms>=15000&&ms<=30000));
      assert.ok(sent.every(mail=>!mail.cc&&!mail.bcc&&typeof mail.to==='string'));failAt=-1;
    });
    await t.test('queued cancellation and start guard, stale callbacks, restart state',async()=>{
      const send=app.transporter.sendMail;let release;
      app.transporter.sendMail=()=>new Promise(resolve=>{release=resolve;});
      await prepare();await action('SKIP_IMAGE');await action('CONFIRM_SEND');
      while(!release)await new Promise(resolve=>setImmediate(resolve));
      const first=app.userStates.get(1);await message({text:'/start'});assert.equal(app.userStates.get(1),first);
      await message({text:'/cancel'});assert.equal(app.userStates.get(1),first);
      await prepare(1,2);await action('SKIP_IMAGE',2);await action('CONFIRM_SEND',2);
      const second=app.userStates.get(2);await message({text:'/start'},2);assert.equal(app.userStates.get(2),second);
      await message({text:'/cancel'},2);assert.ok(!app.userStates.has(2));
      release({accepted:['test']});await app.getQueue();app.transporter.sendMail=send;
      await prepare();const oldId=app.userStates.get(1).id;await message({text:'/cancel'});await prepare();
      await action('SKIP_IMAGE',1,oldId);assert.equal(app.userStates.get(1).step,app.STEPS.WAITING_FOR_IMAGE_CHOICE);
      app.clearUserState(1);await action('CONFIRM_SEND',1,oldId);assert.ok(!app.userStates.has(1));
      await message({text:'/start'});assert.equal(app.userStates.get(1).step,app.STEPS.WAITING_FOR_FILE);
    });
    await t.test('unauthorized users and unknown callbacks cannot create batches',async()=>{
      await message({text:'/start'},3);assert.ok(!app.userStates.has(3));
      assert.ok(calls.at(-1).text.includes('not authorized'));
      const state=app.userStates.get(1);await action('UNKNOWN');assert.equal(app.userStates.get(1),state);
    });
    await t.test('subject validation, cancellation and independent user subjects',async()=>{
      await message({text:'/start'});bytes=workbook();
      await message({document:{file_id:'sheet',file_name:'list.xlsx'}});
      for(const invalid of ['   ','Title\nBody','Title\r\nBcc: other@example.com','x'.repeat(201),'Title\u0000']) {
        await message({text:invalid});assert.equal(app.userStates.get(1).step,app.STEPS.WAITING_FOR_SUBJECT);
        assert.equal(app.userStates.get(1).subject,'');
      }
      const old=app.userStates.get(1);await message({text:'/cancel'});assert.ok(!app.userStates.has(1));assert.equal(old.subject,'');
      await prepare(1,1);await prepare(1,2);
      assert.equal(app.userStates.get(1).subject,'Custom campaign subject 1');
      assert.equal(app.userStates.get(2).subject,'Custom campaign subject 2');
      await message({text:'/cancel'},2);
      const first=app.userStates.get(1);await message({text:'/cancel'});assert.equal(first.subject,'');
      await message({text:'/start'});bytes=workbook();await message({document:{file_id:'sheet',file_name:'list.xlsx'}});
      const title='عنوان عربي ✨ ' + 'x'.repeat(180);
      await message({text:title});assert.equal(app.userStates.get(1).subject,title);
      await message({text:'   '});assert.equal(app.userStates.get(1).step,app.STEPS.WAITING_FOR_MESSAGE);
      const body='First paragraph.\n\n'+'Long message '.repeat(200);
      await message({text:body});await action('SKIP_IMAGE');
      const preview=calls.filter(c=>c.method==='sendMessage').at(-1).text;
      assert.ok(preview.includes('Message preview:'));assert.ok(preview.length<4096);assert.ok(preview.includes('…'));
      const mail=email.buildMailOptions(app.userStates.get(1),'test@example.com',[]);
      assert.equal(mail.subject,title);assert.ok(mail.text.startsWith(body.trim()));
      await message({text:'/cancel'});
    });
    await t.test('startup verifies SMTP before launch; SMTP failure blocks launch',async()=>{
      const verify=app.transporter.verify,launch=app.bot.launch,order=[];
      try {
        app.transporter.verify=async()=>order.push('verify');app.bot.launch=async(_,cb)=>{order.push('launch');cb();};
        await app.main();assert.deepEqual(order,['verify','launch']);
        app.transporter.verify=async()=>{throw new Error('test failure');};
        await assert.rejects(app.main());assert.equal(order.length,2);
      }finally{app.transporter.verify=verify;app.bot.launch=launch;}
    });
  } finally {
    app.bot.telegram.constructor.prototype.callApi=originalApi;global.fetch=originalFetch;global.setTimeout=originalTimeout;app.transporter.sendMail=originalSend;
    for(const id of app.userStates.keys())app.clearUserState(id);
  }
});
