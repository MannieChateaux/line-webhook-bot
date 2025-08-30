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
const FIELDS = ['keyword'];
const QUESTIONS = {
  keyword: '検索したい車の情報を教えてください（例：スバル インプレッサ、トヨタ ヤリス 2020）'
};

// 2) Webhook 受け口：署名検証→ハンドラ
app.post(
  '/webhook',
  (req, res, next) => middleware({
    channelSecret: config.channelSecret,
    payload: req.rawBody,
  })(req, res, next),
  async (req, res) => {
    const events = req.body.events;
    // 先に 200 を返す（重要）
    res.sendStatus(200);
    // 後処理は非同期で流す
    for (const e of events) handleEvent(e).catch(console.error);
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


// フリーワード検索でIAucデータ取得
async function fetchIaucResults({ keyword }) {
  console.log('フリーワード検索開始:', keyword);
  
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
  let browser, page;
  
  try {
    browser = await puppeteer.launch({
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

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
    await page.setViewport({ width: 1280, height: 800 });

    // ログイン処理
    console.log('IAucサイトにアクセス中...');
    await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'domcontentloaded' });

    const needsLogin = await page.$('#userid') || await page.$('input[name=userid]');
    
    if (needsLogin) {
      console.log('ログイン処理中...');
      const uid = process.env.IAUC_USER_ID;
      const pw = process.env.IAUC_PASSWORD;
      
      if (!uid || !pw) {
        throw new Error('IAUC認証情報が設定されていません');
      }

      const userSelectors = ['#userid', 'input[name=userid]', 'input[name="user"]'];
      for (const selector of userSelectors) {
        if (await page.$(selector)) {
          await page.type(selector, uid, { delay: 50 });
          break;
        }
      }

      const passSelectors = ['#password', 'input[name=password]', 'input[type="password"]'];
      for (const selector of passSelectors) {
        if (await page.$(selector)) {
          await page.type(selector, pw, { delay: 50 });
          break;
        }
      }

      const loginButton = await page.$('input[type=submit], button[type=submit]');
      if (loginButton) {
        await loginButton.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        console.log('ログイン完了');
      }
    }

    // 会場選択
    console.log('会場選択中...');
    await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'domcontentloaded' });
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    await page.click('#btn_vehicle_everyday_all');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await page.click('#btn_vehicle_day_all');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await page.click('button.page-next-button.col-md-2.col-xs-4');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });

    // フリーワード検索
    console.log('フリーワード検索実行中...');
    await page.click('#button_freeword_search');
    await new Promise(resolve => setTimeout(resolve, 1000));

    await page.type('input[name="freeword_search"]', keyword, { delay: 100 });

    const searchButton = await page.$('button[type="submit"], input[value="検索"]');
    if (searchButton) {
      await searchButton.click();
    } else {
      await page.keyboard.press('Enter');
    }

    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      console.log('ナビゲーション待機タイムアウト');
    }

    await new Promise(resolve => setTimeout(resolve, 3000));

    // 結果スクレイピング
    const items = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tbody tr'));
      if (rows.length <= 1) return [];

      return rows.slice(1, 11).map((row, index) => {
        const cells = row.querySelectorAll('td');
        let title = '', price = '', km = '', imageUrl = '', url = '';
        
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          const img = cell.querySelector('img');
          const link = cell.querySelector('a');
          
          if (text.match(/\w+/) && text.length > 3 && !title) {
            title = text;
          }
          if (text.includes('万円') || text.includes('円')) {
            price = text;
          }
          if (text.includes('km') && text.match(/\d/)) {
            km = text;
          }
          if (img && !imageUrl) {
            imageUrl = img.src;
          }
          if (link && !url) {
            url = link.href;
          }
        }
        
        return {
          title: title || `車両 ${index + 1}`,
          price: price || '価格情報なし',
          km: km || '走行距離情報なし',
          imageUrl: imageUrl || '',
          url: url || ''
        };
      });
    });

    for (const item of items) {
      if (item.url && item.url.startsWith('/')) {
        item.url = 'https://www.iauc.co.jp' + item.url;
      }
      if (item.imageUrl && item.imageUrl.startsWith('/')) {
        item.imageUrl = 'https://www.iauc.co.jp' + item.imageUrl;
      }
    }

    console.log('検索完了:', items.length, '件');
    return items;

  } catch (error) {
    console.error('検索エラー:', error);
    throw error;
  } finally {
    if (page) await page.close().catch(console.error);
    if (browser) await browser.close().catch(console.error);
  }
}

async function handleEvent(event) {
  console.log('📨 イベント受信:', event.type, event.message?.type);
  
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const uid   = event.source.userId;
  const text  = event.message.text.trim();
  const token = event.replyToken;

  console.log('👤 ユーザーID:', uid);
  console.log('💬 受信テキスト:', text);

  // 初回質問
  if (!sessions.has(uid)) {
    console.log('🆕 新規セッション開始');
    sessions.set(uid, { step: 0, data: {} });
    return client.replyMessage(token, { type:'text', text: QUESTIONS.keyword });
  }

  // 回答保存＆次へ
  const session = sessions.get(uid);
  const field   = FIELDS[session.step];
  session.data.keyword = text;
  session.step++;

  console.log('💾 セッション更新:', session);
 
  // 終了メッセージ
  console.log('🔍 検索開始 - 収集した条件:', session.data);
  await client.replyMessage(token, {
    type: 'text',
    text: '✅ 条件が揃いました。検索結果を取得中…少々お待ちください！'
  });

  try {
    // IAuc 検索実行
    console.log('🚀 IAuc検索を開始...');
    const results = await fetchIaucResults(session.data);
    console.log('📊 検索結果:', results?.length || 0, '件');

    // 0件ならテキスト通知して終了
    if (!results || results.length === 0) {
      console.log('❌ 検索結果が0件でした');
      await client.pushMessage(uid, {
        type: 'text',
        text: '該当する車両が見つかりませんでした。メーカー/車種の表記や金額・距離の単位（万、km）を見直してもう一度お試しください。'
      });
      sessions.delete(uid);
      return;
    }

    // Flex メッセージ用バブル生成
    console.log('🎨 Flexメッセージを生成中...');
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
   
    // Flex メッセージで検索結果を返信
    console.log('📤 検索結果を送信中...');
    await client.pushMessage(uid, {
      type: 'flex',
      altText: 'IAuc 検索結果はこちらです',
      contents: {
        type: 'carousel',
        contents: bubbles,
      },
    });
    console.log('✅ 検索結果送信完了');

  } catch (error) {
    console.error('❌ 検索処理でエラーが発生:', error);
    console.error('❌ スタックトレース:', error.stack);
    
    await client.pushMessage(uid, {
      type: 'text',
      text: 'エラーが発生しました。しばらく経ってから再度お試しください。'
    }).catch(console.error);
  } finally {
    // 会話セッションをクリア
    console.log('🧹 セッションをクリア');
    sessions.delete(uid);
  }
}

// エラー時も 200 応答
app.use((err, req, res, next) => {
  console.error(err);
  res.sendStatus(200);
});

// 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡️ Server running on port ${PORT}`));
