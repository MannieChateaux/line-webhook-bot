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


// ―― IAuc 実データ取得関数 ―――
async function fetchIaucResults({ maker, model, budget, mileage }) {
  // Puppeteer をヘッドレスモードで起動
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  // 1) ログインページへ
  await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'networkidle2' });

  // 2) ID と PASSWORD を入力してログイン
  await page.type('#userid', process.env.IAUC_USER_ID);
  await page.type('#password', process.env.IAUC_PASSWORD);
  await Promise.all([
    page.click('input[type=submit]'),
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
  ]);

  // 3) 検索フォームに各条件をセット
  await page.select('select[name=maker]', maker);
  await page.select('select[name=model]', model);
  await page.type('input[name=budget]', budget);
  await page.type('input[name=mileage]', mileage);

  // 4) 検索ボタンをクリックして結果ページへ
  await Promise.all([
    page.click('button#searchButton'),
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
  ]);

  // 5) 結果リストをスクレイピング
  const items = await page.$$eval('.result-item', cards =>
    cards.map(card => {
      const title    = card.querySelector('.item-title')?.textContent.trim() || '';
      const price    = card.querySelector('.item-price')?.textContent.trim() || '';
      const km       = card.querySelector('.item-km')?.textContent.trim()    || '';
      const imageUrl = card.querySelector('img')?.src || '';
      const url      = card.querySelector('a.details')?.href || '';
      return { title, price, km, imageUrl, url };
    })
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


// — 会話セッションをクリア —
sessions.delete(uid);
} 

// エラー時も 200 応答
app.use((err, req, res, next) => {
  console.error(err);
  res.sendStatus(200);
});
}  // ← ここが handleEvent の終わりの「}」

// 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡️ Server running on port ${PORT}`));
