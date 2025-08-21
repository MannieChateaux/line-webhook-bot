const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
const axios = require('axios');       // ← 追加
const puppeteer = require('puppeteer');

// 環境変数
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
};

const client = new Client(config);
const app = express();

// 1) express.json に verify で rawBody をセット
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// セッション保持用
const sessions = new Map();
const FIELDS = ['maker','model','budget','mileage'];
const QUESTIONS = {
  maker:   '🚗 メーカーを教えてください（例：トヨタ、スバル）',
  model:   '🚗 車名を教えてください（例：ヤリス、サンバー）',
  budget:  '💰 予算を教えてください（例：50万、200万）',
  mileage: '📏 走行距離上限を教えてください（例：1万km、5万km）',
};

// 2) Webhook 受け口：署名検証→ハンドラ
app.post(
  '/webhook',
  // signature middleware に rawBody を渡す
  (req, res, next) => middleware({ 
    channelSecret: config.channelSecret, 
    payload: req.rawBody 
  })(req, res, next),
  async (req, res) => {
    // この時点で req.body はパース済み
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
}
);

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const uid   = event.source.userId;
  const text  = event.message.text.trim();
  const token = event.replyToken;

  // 初回質問
  if (!sessions.has(uid)) {
    sessions.set(uid, { step: 0, data: {} });
    return client.replyMessage(token, { type:'text', text: QUESTIONS.maker });
  }

  // 回答保存＆次へ
  const session = sessions.get(uid);
  const field   = FIELDS[session.step];
  session.data[field] = text;
  session.step++;

  if (session.step < FIELDS.length) {
    const next = FIELDS[session.step];
    return client.replyMessage(token, { type:'text', text: QUESTIONS[next] });
  }
 
  // —— 終了メッセージ —————————
 await client.replyMessage(token, {
   type: 'text',
   text: '✅ 条件が揃いました。検索結果を取得中…少々お待ちください！'
 });

// ★ ここを追加：IAuc 検索実行
const results = await fetchIaucResults(session.data);

// --- IAuc 実データ取得関数（この1つだけ残す）---
async function fetchIaucResults({ maker, model, budget, mileage }) {
 const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
  ],
  // 環境変数があれば使う／無ければ Puppeteer が落とした Chromium を使う
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
});

  const page = await browser.newPage();

  // ← ここで page のタイムアウトを設定（launchオプションではない）
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'networkidle2' });

  // フォームの表示待ち
  await page.waitForSelector('#userid', { visible: true, timeout: 60000 });
  await page.waitForSelector('#password', { visible: true, timeout: 60000 });

  // ログイン
  await Promise.all([
    page.type('#userid',   process.env.IAUC_USER_ID),
    page.type('#password', process.env.IAUC_PASSWORD),
  ]);
  await Promise.all([
    page.click('input[type=submit]'),
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
  ]);

  // （以降はそのままでOK）
  await page.select('select[name=maker]',  maker);
  await page.select('select[name=model]',  model);
  await page.type('input[name=budget]',    budget);
  await page.type('input[name=mileage]',   mileage);

  await Promise.all([
    page.click('button#searchButton'),
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
  ]);

  const items = await page.$$eval('.result-item', cards =>
    cards.map(card => ({
      title:    card.querySelector('.item-title')?.textContent.trim() || '',
      price:    card.querySelector('.item-price')?.textContent.trim() || '',
      km:       card.querySelector('.item-km')?.textContent.trim() || '',
      imageUrl: card.querySelector('img')?.src || '',
      url:      card.querySelector('a.details')?.href || '',
    }))
  );

  await browser.close();
  return items;
}

 // —— Flex メッセージ用バブル生成 —————————
 const bubbles = results.slice(0,5).map(item => ({
   type: 'bubble',
   hero: {
     type: 'image',
     url: item.imageUrl || 'https://via.placeholder.com/240',
     size: 'full',
     aspectRatio: '1:1',
     aspectMode: 'cover',
   },
   body: {
     type: 'box',
     layout: 'vertical',
     contents: [
       { type: 'text', text: item.title, weight: 'bold', size: 'md' },
       { type: 'text', text: `${item.price}円以下`, margin: 'sm' },
       { type: 'text', text: `${item.km}km以下`, margin: 'sm' },
     ],
   },
   footer: {
     type: 'box',
     layout: 'vertical',
     spacing: 'sm',
     contents: [
       {
         type: 'button',
         style: 'link',
         height: 'sm',
         action: {
           type: 'uri',
           label: '詳細を見る',
           uri: item.url,
         },
       },
     ],
   },
 }));
 
  // —— Flex メッセージで検索結果を返信 —————————
 await client.pushMessage(uid, {
   type: 'flex',
   altText: 'IAuc 検索結果はこちらです',
   contents: {
     type: 'carousel',
     contents: bubbles,
   },
 });

  // —— 会話セッションをクリア —————————
  sessions.delete(uid);
}

// エラー時も 200 応答
app.use((err, req, res, next) => {
  console.error(err);
  res.sendStatus(200);
});

// 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡️ Server running on port ${PORT}`));
