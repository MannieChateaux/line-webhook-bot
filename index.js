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


// 修正版: IAuc検索フォーム操作
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

    // 2) ログイン処理（既存のログインコードをそのまま使用）
    const needsLogin = await page.$('#userid') || await page.$('input[name=userid]');
    
    if (needsLogin) {
      console.log('🔑 ログイン処理を実行...');
      const uid = process.env.IAUC_USER_ID;
      const pw  = process.env.IAUC_PASSWORD;
      
      if (!uid || !pw) {
        throw new Error('IAUC_USER_ID / IAUC_PASSWORD not set');
      }

      // ログイン実行
      const userSelectors = ['#userid', 'input[name=userid]', 'input[name="user"]', 'input[type="text"]:first-of-type'];
      for (const selector of userSelectors) {
        const userField = await page.$(selector);
        if (userField) {
          await page.type(selector, uid, { delay: 50 });
          console.log('✅ ユーザーID入力完了');
          break;
        }
      }

      const passSelectors = ['#password', 'input[name=password]', 'input[type="password"]'];
      for (const selector of passSelectors) {
        const passField = await page.$(selector);
        if (passField) {
          await page.type(selector, pw, { delay: 50 });
          console.log('✅ パスワード入力完了');
          break;
        }
      }

      // ログインボタンクリック
      const loginButton = await page.$('input[type=submit], button[type=submit]');
      if (loginButton) {
        await loginButton.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        console.log('✅ ログイン完了');
      }
    }

    // 3) 検索ページが表示されるまで待機
    await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'domcontentloaded' });
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('🔍 検索フォーム操作開始...');

    // 4) 修正版: チェックボックス形式での検索条件設定
    await page.evaluate(({ maker, model, budget, mileage }) => {
      console.log('🎯 検索条件設定:', { maker, model, budget, mileage });
      
      // メーカー選択（チェックボックス）
      if (maker) {
        const makerCheckboxes = document.querySelectorAll('input[name="maker[]"]');
        const makerLabels = document.querySelectorAll('.search-maker-checkbox');
        
        // ラベルのテキストからメーカーを探す
        for (let i = 0; i < makerLabels.length; i++) {
          const label = makerLabels[i];
          if (label.textContent && label.textContent.includes(maker)) {
            const checkbox = makerCheckboxes[i];
            if (checkbox && !checkbox.checked) {
              checkbox.click();
              console.log('✅ メーカー選択:', maker);
              break;
            }
          }
        }
        
        // 代替方法：li要素からテキストで検索
        const makerLIs = document.querySelectorAll('li.drag_label.search-maker-checkbox');
        for (const li of makerLIs) {
          if (li.textContent && li.textContent.includes(maker)) {
            const checkbox = li.querySelector('input[type="checkbox"]');
            if (checkbox && !checkbox.checked) {
              checkbox.click();
              console.log('✅ メーカー選択（li経由）:', maker);
              break;
            }
          }
        }
      }
      
      // 少し待機してから車種選択
      setTimeout(() => {
        if (model) {
          // 車種選択（メーカー選択後に表示される可能性）
          const allCheckboxes = document.querySelectorAll('input[type="checkbox"]');
          const allLabels = document.querySelectorAll('li');
          
          for (const label of allLabels) {
            if (label.textContent && label.textContent.includes(model)) {
              const checkbox = label.querySelector('input[type="checkbox"]');
              if (checkbox && !checkbox.checked) {
                checkbox.click();
                console.log('✅ 車種選択:', model);
                break;
              }
            }
          }
        }
        
        // 予算・走行距離設定（もし入力欄があれば）
        const budgetInput = document.querySelector('input[name*="price"], input[name*="budget"]');
        if (budgetInput && budget) {
          const budgetNum = budget.replace(/[^\d]/g, '') + '0000'; // 万→円変換
          budgetInput.value = budgetNum;
          budgetInput.dispatchEvent(new Event('input', { bubbles: true }));
          console.log('✅ 予算設定:', budgetNum);
        }
        
        const mileageInput = document.querySelector('input[name*="mileage"], input[name*="distance"]');
        if (mileageInput && mileage) {
          const mileageNum = mileage.replace(/[^\d]/g, '') + '0000'; // 万km→km変換
          mileageInput.value = mileageNum;
          mileageInput.dispatchEvent(new Event('input', { bubbles: true }));
          console.log('✅ 走行距離設定:', mileageNum);
        }
      }, 1000);
      
    }, { maker, model, budget, mileage });

    // 5) 検索実行
    console.log('🚀 検索実行中...');
    await new Promise(resolve => setTimeout(resolve, 2000)); // 設定完了を待機
    
    // 検索ボタンをクリック
    const searchExecuted = await page.evaluate(() => {
      // 検索ボタンを複数パターンで探す
      const searchSelectors = [
        'input[type="submit"][value*="検索"]',
        'button[type="submit"]',
        'input[type="submit"]',
        'button:contains("検索")',
        '.search-btn',
        '#search-btn'
      ];
      
      for (const selector of searchSelectors) {
        const btn = document.querySelector(selector);
        if (btn) {
          btn.click();
          console.log('✅ 検索ボタンクリック:', selector);
          return true;
        }
      }
      
      // フォーム送信を直接実行
      const form = document.querySelector('#exhibit_search');
      if (form) {
        form.submit();
        console.log('✅ フォーム直接送信');
        return true;
      }
      
      return false;
    });

    if (!searchExecuted) {
      console.log('⚠️ 検索ボタンが見つからないため、Enterキーで送信');
      await page.keyboard.press('Enter');
    }

    // 6) 検索結果待機
    console.log('⏳ 検索結果を待機中...');
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      console.log('✅ 検索結果ページに移動');
    } catch (e) {
      console.log('⚠️ ナビゲーション待機タイムアウト、現在ページで継続');
    }

    // 7) 検索結果のスクレイピング
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const items = await page.evaluate(() => {
      // 結果要素を探す
      const selectors = [
        '.vehicle-item',
        '.car-item', 
        '.search-result-item',
        '.result-item',
        'tr[class*="result"]',
        'li[class*="vehicle"]',
        '.list-item'
      ];
      
      let cards = [];
      for (const selector of selectors) {
        cards = Array.from(document.querySelectorAll(selector));
        if (cards.length > 0) {
          console.log(`✅ 結果要素発見: ${selector} (${cards.length}件)`);
          break;
        }
      }
      
      if (cards.length === 0) {
        console.log('❌ 検索結果要素が見つかりません');
        return [];
      }

      return cards.slice(0, 10).map((card, index) => {
        const getText = (selectors) => {
          for (const s of selectors) {
            const el = card.querySelector(s);
            if (el && el.textContent) return el.textContent.trim();
          }
          return '';
        };
        
        const getAttr = (selectors, attr) => {
          for (const s of selectors) {
            const el = card.querySelector(s);
            if (el && el.getAttribute(attr)) return el.getAttribute(attr);
          }
          return '';
        };

        const title = getText([
          '.title', '.name', '.vehicle-name', '.car-name', 'h1', 'h2', 'h3', 'strong'
        ]) || `車両 ${index + 1}`;
        
        const price = getText([
          '.price', '.cost', '.amount', '*[class*="price"]'
        ]) || '価格情報なし';
        
        const km = getText([
          '.mileage', '.distance', '.km', '*[class*="mileage"]'
        ]) || '走行距離情報なし';
        
        const imageUrl = getAttr(['img'], 'src');
        const url = getAttr(['a'], 'href');

        return { title, price, km, imageUrl, url };
      });
    });

    // 相対URL → 絶対URL変換
    for (const item of items) {
      if (item.url && item.url.startsWith('/')) {
        item.url = 'https://www.iauc.co.jp' + item.url;
      }
      if (item.imageUrl && item.imageUrl.startsWith('/')) {
        item.imageUrl = 'https://www.iauc.co.jp' + item.imageUrl;
      }
    }

    console.log('✅ fetchIaucResults完了:', items.length, '件');
    return items;

  } catch (error) {
    console.error('❌ fetchIaucResults エラー:', error);
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
