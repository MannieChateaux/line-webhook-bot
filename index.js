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

// ヘルスチェック
app.get('/healthz', (_req, res) => res.send('ok'));


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
// ここで待たない：すぐ 200 を返す
events.forEach(e => handleEvent(e).catch(console.error));
res.sendStatus(200);
}
);

// <select> を「value」ではなく「表示ラベル」で選ぶ
async function selectByLabel(page, selectSelector, labelText) {
  if (!labelText) return;
  await page.evaluate(({ sel, label }) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const opts = Array.from(el.options);
    const hit = opts.find(o =>
      (o.textContent || '').trim().includes(label.trim())
    );
    if (hit) {
      el.value = hit.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { sel: selectSelector, label: labelText });
}

// 「50万」→「500000」、「5万km」→「50000」などの正規化
function toNumberYen(text) {
  if (!text) return '';
  const t = String(text).replace(/[^\d万]/g, '');
  if (!t) return '';
  if (t.endsWith('万')) {
    const n = parseInt(t.replace('万', ''), 10);
    return isNaN(n) ? '' : String(n * 10000);
  }
  return String(parseInt(t, 10) || '');
}
function toNumberKm(text) {
  if (!text) return '';
  const t = String(text).replace(/[^\d万]/g, '');
  if (!t) return '';
  if (t.endsWith('万')) {
    const n = parseInt(t.replace('万', ''), 10);
    return isNaN(n) ? '' : String(n * 10000);
  }
  return String(parseInt(t, 10) || '');
}

// 要素があるときだけ type する（安全運転）
async function typeIfExists(page, selector, value) {
  if (!value) return;
  const el = await page.$(selector);
  if (el) await page.type(selector, value, { delay: 20 });
}


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

  // 0件ならテキスト通知して終了
if (!results || results.length === 0) {
  await client.pushMessage(uid, {
    type: 'text',
    text: '該当する車両が見つかりませんでした。メーカー/車種の表記や金額・距離の単位（万、km）を見直してもう一度お試しください。'
  });
  sessions.delete(uid);
  return;
}

// --- IAuc 実データ取得関数 ---
async function fetchIaucResults({ maker, model, budget, mileage }) {
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
  console.log('Using Chrome at:', execPath);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
    ],
    executablePath: execPath,
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  // 実ブラウザっぽい UA・日本語優先
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
  await page.setViewport({ width: 1280, height: 800 });

  // 1) ログインページへ
  await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'domcontentloaded' });

  // 2) ログイン必要か判定してログイン
  const needsLogin = await page.$('#userid') || await page.$('input[name=userid]');
  if (needsLogin) {
    await page.waitForSelector('#userid, input[name=userid]', { visible: true });
    await page.waitForSelector('#password, input[name=password]', { visible: true });

    const uid = process.env.IAUC_USER_ID;
    const pw  = process.env.IAUC_PASSWORD;
    if (!uid || !pw) throw new Error('IAUC_USER_ID / IAUC_PASSWORD not set');

    await typeIfExists(page, '#userid', uid);
    await typeIfExists(page, 'input[name=userid]', uid);
    await typeIfExists(page, '#password', pw);
    await typeIfExists(page, 'input[name=password]', pw);

    await Promise.all([
      page.click('input[type=submit], button[type=submit]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);
  }

  // 3) 検索フォーム待機
  await page.waitForSelector('select[name=maker], select[name=model], input[name=budget]', { timeout: 20000 });

  // 4) 条件入力（メーカー/車種はラベル選択、数値は正規化）
  await selectByLabel(page, 'select[name=maker]', maker || '');
  await selectByLabel(page, 'select[name=model]', model || '');
  await typeIfExists(page, 'input[name=budget]',  toNumberYen(budget));
  await typeIfExists(page, 'input[name=mileage]', toNumberKm(mileage));

  // 5) 検索実行 → 遷移待ち
  await Promise.all([
    page.click('button#searchButton, button[name=search], input#searchButton, input[name=search]'),
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
  ]);

  // 6) 結果待機（無くても続行）
  await page.waitForSelector('.result-item, .search-result, .list-item', { timeout: 15000 }).catch(() => {});

  // 7) スクレイピング（複数候補から拾う）
  const items = await page.evaluate(() => {
    const qs = (sel) => Array.from(document.querySelectorAll(sel));
    const cards =
      qs('.result-item').length      ? qs('.result-item')      :
      qs('.search-result li').length ? qs('.search-result li') :
      qs('.list-item').length        ? qs('.list-item')        : [];

    return cards.slice(0, 10).map((card) => {
      const pick = (sels) => {
        for (const s of sels) {
          const el = card.querySelector(s);
          if (el) return (el.textContent || '').trim();
        }
        return '';
      };
      const pickAttr = (sels, attr) => {
        for (const s of sels) {
          const el = card.querySelector(s);
          if (el && el.getAttribute(attr)) return el.getAttribute(attr);
        }
        return '';
      };

      const title    = pick(['.item-title', '.title', '.name', 'h3', 'h2']);
      const price    = pick(['.item-price', '.price']);
      const km       = pick(['.item-km', '.mileage']);
      const imageUrl = pickAttr(['img', '.thumb img'], 'src');
      const url      = pickAttr(['a.details', 'a.more', 'a[href*="vehicle"]', 'a'], 'href');

      return { title, price, km, imageUrl, url };
    });
  });

  // 相対URL → 絶対URL補正
for (const it of items) {
  if (it.url && it.url.startsWith('/')) it.url = 'https://www.iauc.co.jp' + it.url;
  if (it.imageUrl && it.imageUrl.startsWith('/')) it.imageUrl = 'https://www.iauc.co.jp' + it.imageUrl;
}

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
