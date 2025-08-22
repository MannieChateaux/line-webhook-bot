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


// --- IAuc 実データ取得関数 ---
async function fetchIaucResults({ maker, model, budget, mileage }) {
  console.log('🔍 fetchIaucResults開始:', { maker, model, budget, mileage });
  
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
  console.log('📍 Using Chrome at:', execPath);

  let browser;
  let page;
  
  try {
    console.log('🚀 Puppeteerブラウザ起動中...');
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

    console.log('📄 新しいページを作成中...');
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    // 実ブラウザっぽい UA・日本語優先
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
    await page.setViewport({ width: 1280, height: 800 });

    // 1) ログインページへ
    console.log('🌐 IAucサイトにアクセス中...');
    await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'domcontentloaded' });
    console.log('✅ ページロード完了');

    // 2) ログイン必要か判定してログイン
    console.log('🔐 ログイン必要性をチェック中...');
    const needsLogin = await page.$('#userid') || await page.$('input[name=userid]');
    
    if (needsLogin) {
      console.log('🔑 ログインが必要です。ログイン処理を開始...');
      await page.waitForSelector('#userid, input[name=userid]', { visible: true });
      await page.waitForSelector('#password, input[name=password]', { visible: true });

      const uid = process.env.IAUC_USER_ID;
      const pw  = process.env.IAUC_PASSWORD;
      
      if (!uid || !pw) {
        console.error('❌ IAUC認証情報が設定されていません');
        throw new Error('IAUC_USER_ID / IAUC_PASSWORD not set');
      }

      console.log('📝 ログイン情報を入力中...');
      await typeIfExists(page, '#userid', uid);
      await typeIfExists(page, 'input[name=userid]', uid);
      await typeIfExists(page, '#password', pw);
      await typeIfExists(page, 'input[name=password]', pw);

      console.log('🚪 ログインボタンをクリック...');
      await Promise.all([
        page.click('input[type=submit], button[type=submit]'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
      ]);
      console.log('✅ ログイン完了');
    } else {
      console.log('ℹ️ ログイン不要です');
    }

    // 3) 検索フォーム待機
    console.log('🔍 検索フォームを待機中...');
    await page.waitForSelector('select[name=maker], select[name=model], input[name=budget]', { timeout: 20000 });
    console.log('✅ 検索フォーム発見');

    // 4) 条件入力（メーカー/車種はラベル選択、数値は正規化）
    console.log('📊 検索条件を入力中...');
    console.log('- メーカー:', maker);
    await selectByLabel(page, 'select[name=maker]', maker || '');
    
    console.log('- 車種:', model);
    await selectByLabel(page, 'select[name=model]', model || '');
    
    const budgetNum = toNumberYen(budget);
    console.log('- 予算:', budget, '→', budgetNum);
    await typeIfExists(page, 'input[name=budget]', budgetNum);
    
    const mileageNum = toNumberKm(mileage);
    console.log('- 走行距離:', mileage, '→', mileageNum);
    await typeIfExists(page, 'input[name=mileage]', mileageNum);

    // 5) 検索実行 → 遷移待ち
    console.log('🚀 検索を実行中...');
    await Promise.all([
      page.click('button#searchButton, button[name=search], input#searchButton, input[name=search]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);
    console.log('✅ 検索結果ページに遷移');

    // 6) 結果待機（無くても続行）
    console.log('📝 結果要素を待機中...');
    await page.waitForSelector('.result-item, .search-result, .list-item', { timeout: 15000 }).catch((err) => {
      console.log('⚠️ 結果要素が見つかりませんでした:', err.message);
    });

    // 7) スクレイピング（複数候補から拾う）
    console.log('🎯 データをスクレイピング中...');
    const items = await page.evaluate(() => {
      const qs = (sel) => Array.from(document.querySelectorAll(sel));
      const cards =
        qs('.result-item').length      ? qs('.result-item')      :
        qs('.search-result li').length ? qs('.search-result li') :
        qs('.list-item').length        ? qs('.list-item')        : [];

      console.log('🎯 発見したカード数:', cards.length);
      
      return cards.slice(0, 10).map((card, index) => {
        console.log(`📋 カード${index + 1}を処理中...`);
        
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

    console.log('📊 スクレイピング結果:', items.length, '件');
    items.forEach((item, index) => {
      console.log(`${index + 1}:`, item.title || 'タイトルなし');
    });

    // 相対URL → 絶対URL補正
    for (const it of items) {
      if (it.url && it.url.startsWith('/')) it.url = 'https://www.iauc.co.jp' + it.url;
      if (it.imageUrl && it.imageUrl.startsWith('/')) it.imageUrl = 'https://www.iauc.co.jp' + it.imageUrl;
    }

    console.log('✅ fetchIaucResults完了:', items.length, '件の結果');
    return items;

  } catch (error) {
    console.error('❌ fetchIaucResults エラー:', error);
    console.error('❌ スタックトレース:', error.stack);
    throw error;
  } finally {
    if (page) {
      console.log('🧹 ページを閉じています...');
      await page.close().catch(console.error);
    }
    if (browser) {
      console.log('🧹 ブラウザを閉じています...');
      await browser.close().catch(console.error);
    }
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
    return client.replyMessage(token, { type:'text', text: QUESTIONS.maker });
  }

  // 回答保存＆次へ
  const session = sessions.get(uid);
  const field   = FIELDS[session.step];
  session.data[field] = text;
  session.step++;

  console.log('💾 セッション更新:', session);

  if (session.step < FIELDS.length) {
    const next = FIELDS[session.step];
    console.log('❓ 次の質問:', QUESTIONS[next]);
    return client.replyMessage(token, { type:'text', text: QUESTIONS[next] });
  }
 
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
