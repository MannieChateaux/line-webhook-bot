const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// 2段階ログイン最終案（マッシュアップ版）
// 116行目から217行目付近のログイン処理部分を以下に完全置換

console.log('IAuc 2段階ログインフロー開始...');

const uid = process.env.IAUC_USER_ID;
const pw = process.env.IAUC_PASSWORD;
if (!uid || !pw) throw new Error('IAUC_USER_ID / IAUC_PASSWORD が未設定');

// ログイン状態確認関数
async function isLoggedIn() {
  try {
    const logoutLink = await page.$('a[href*="/service/logout"]');
    return !!logoutLink;
  } catch {
    return false;
  }
}

if (!(await isLoggedIn())) {
  console.log('2段階ログイン処理開始...');
  
  // STAGE 1: ログインページに直接アクセス
  console.log('STAGE 1: ログインページへ直接アクセス');
  await page.goto('https://www.iauc.co.jp/service/login', { waitUntil: 'domcontentloaded' });
  
  // STAGE 2: フォーム要素が出現するまで待機
  console.log('STAGE 2: ログインフォーム要素の待機');
  await page.waitForSelector('#userid', { timeout: 20000 });
  await page.waitForSelector('#password', { timeout: 20000 });
  await page.waitForSelector('#login_button', { timeout: 20000 });
  
  // STAGE 3: ID/パスワード入力
  console.log('STAGE 3: ID/パスワード入力');
  await page.type('#userid', uid, { delay: 40 });
  await page.type('#password', pw, { delay: 40 });
  
  // STAGE 4: ログインボタンクリック
  console.log('STAGE 4: ログインボタンクリック');
  await page.click('#login_button');
  
  // STAGE 5: ログイン済み状態かURLベースで成功判定
  console.log('STAGE 5: ログイン成功判定');
  
  // 複数の成功条件を並行して待機
  await Promise.race([
    page.waitForSelector('a[href*="/service/logout"]', { timeout: 30000 }),
    page.waitForFunction(() => location.href.includes('/vehicle/'), { timeout: 30000 })
  ]).catch(() => {
    // タイムアウトの場合は現在の状態をチェック
    console.log('成功判定タイムアウト、現在状態を確認中...');
  });
  
  // STAGE 6: 最終確認と/vehicle/への遷移
  console.log('STAGE 6: 最終確認');
  const currentUrl = page.url();
  const loginSuccess = await isLoggedIn();
  const onVehiclePage = currentUrl.includes('/vehicle/');
  
  console.log('ログイン遷移後 URL:', currentUrl);
  console.log('ログアウトリンク存在:', loginSuccess);
  console.log('vehicle ページ到達:', onVehiclePage);
  
  if (!loginSuccess && !onVehiclePage) {
    // vehicle ページに手動遷移を試行
    console.log('vehicle ページに手動遷移中...');
    try {
      await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'networkidle2', timeout: 30000 });
      const afterManualUrl = page.url();
      console.log('手動遷移後 URL:', afterManualUrl);
      
      if (!afterManualUrl.includes('/vehicle/')) {
        const debugInfo = await page.evaluate(() => ({
          title: document.title,
          bodyPreview: document.body.innerText.substring(0, 500)
        }));
        console.log('ログイン失敗デバッグ情報:', debugInfo);
        throw new Error('ログインに失敗しました（ログアウトリンクが見つからず、vehicle ページにも到達できません）');
      }
    } catch (navError) {
      throw new Error('ログインに失敗しました（vehicle ページへの遷移も失敗）');
    }
  }
  
  console.log('ログイン完了！');
} else {
  console.log('既にログイン済み');
}

  // 会場選択ページへ
console.log('会場選択ページへ移動中...');
await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'networkidle2' });
console.log('現在のページURL:', page.url(), 'title:', await page.title());

// --- インフォメーション画面 → 検索UIへ復旧 ---
await sleep(600);
const uiSelectors = ['#btn_vehicle_everyday_all', '#vehicle_everyday .checkbox_on_all', '#btn_vehicle_day_all'];
let uiFound = false;
for (const s of uiSelectors) { if (await page.$(s)) { uiFound = true; break; } }

if (!uiFound) {
  const isInfo = await page.evaluate(() => {
    const body = (document.body?.innerText || '');
    return /インフォメーション|Information/i.test(document.title) || /インフォメーション|Information/i.test(body);
  });

  if (isInfo) {
    console.log('vehicle はインフォメーション画面。復旧リンクを探索します...');
    const clicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const hit = links.find(a =>
        /検索|会場|車両|フリーワード/.test(a.textContent || '') ||
        /vehicle\/(search|list|)/.test(a.getAttribute('href') || '')
      );
      if (hit) { hit.click(); return true; }
      return false;
    });
    if (clicked) {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(()=>{});
      console.log('復旧後URL:', await page.url());
    } else {
      // 直接 vehicle 再ロード
      await page.goto('https://www.iauc.co.jp/vehicle/', { waitUntil: 'networkidle2' });
    }
  }

  // もう一度UIの存在確認＆ダメならデバッグ出力
  let stillMissing = true;
  for (const s of uiSelectors) { if (await page.$(s)) { stillMissing = false; break; } }
  if (stillMissing) {
    try {
      const preview = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400));
      console.log('vehicle body preview:', preview);
      await page.screenshot({ path: '/tmp/vehicle_info_screen.png', fullPage: true }).catch(()=>{});
    } catch {}
    // ここでは throw せず、下の safeClick のデバッグでも拾う
  }
}
// --- 復旧ここまで ---

// 全フレーム横断で待ってクリックするユーティリティ
async function safeClick(selectors, timeout = 45000) {
  const sels = Array.isArray(selectors) ? selectors : [selectors];
  const start = Date.now();

  while (Date.now() - start < timeout) {
    for (const s of sels) {
      for (const f of page.frames()) {
        const el = await f.$(s);
        if (el) {
          try { await f.$eval(s, e => e.click()); }
          catch { await f.evaluate(sel => { const t = document.querySelector(sel); if (t) t.click(); }, s); }
          await sleep(400);
          return true;
        }
      }
    }
    await sleep(300);
  }

  // デバッグ出力（見える候補とフレーム一覧）
  try {
    console.log('iframes:', page.frames().map(fr => fr.url()));
    const candidates = await page.$$eval('a[id^="btn_vehicle_"], button.page-next-button',
      els => els.map(e => ({ id: e.id, cls: e.className, dt: e.getAttribute('data-target'), text: (e.textContent||'').trim() })));
    console.log('btn candidates:', candidates);
    await page.screenshot({ path: '/tmp/vehicle_before_click.png', fullPage: true }).catch(()=>{});
  } catch {}
  throw new Error(`selector not found: ${sels.join(' , ')}`);
}

// 共有在庫＆一発落札「全選択」
console.log('共有在庫の全選択中...');
await safeClick([
  '#btn_vehicle_everyday_all',
  '#vehicle_everyday .checkbox_on_all',
  'a.title-green-button.checkbox_on_all[data-target="#vehicle_everyday"]'
], 30000);

// オークション＆入札会「全選択」
console.log('オークション&入札会の全選択中...');
await safeClick([
  '#btn_vehicle_day_all',
  '#vehicle_day .checkbox_on_all',
  'a.title-button.checkbox_on_all[data-target="#vehicle_day"]'
], 30000);

// 「次へ」
console.log('次へボタンをクリック中...');
await safeClick([
  'button.page-next-button[onclick*="check_sites"]',
  'button.page-next-button'
], 30000);
await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });

// フリーワード検索タブ
console.log('フリーワード検索実行中...');
await safeClick(['#button_freeword_search', 'a#button_freeword_search', 'a[href="#freeword"]#button_freeword_search']);

// 入力
const freewordInputSel = ['input[name="freeword_search"]', 'input[name="freeword"]'];
await safeClick(freewordInputSel, 20000); // 出現待ち
const input = await page.$(freewordInputSel[0]) || await page.$(freewordInputSel[1]);
await input.click();
await page.keyboard.type(keyword, { delay: 30 });

// 送信
const submitSels = ['button[type="submit"]', 'input[value="検索"]', 'button[name="search"]', '#button_freeword_submit'];
let hitSel = null; for (const s of submitSels) { if (await page.$(s)) { hitSel = s; break; } }
if (hitSel) { await safeClick(hitSel); } else { await page.keyboard.press('Enter'); }

try {
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });
} catch { console.log('ナビゲーション待機タイムアウト（続行）'); }

// 結果行が描画されるまで待つ（この行までが置き換え範囲）
await page.waitForSelector('tbody tr', { timeout: 15000 }).catch(()=>{});

// 結果スクレイピング - より詳細な情報取得
console.log('検索結果をスクレイピング中...');
const items = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('tbody tr'));
  console.log('見つかった行数:', rows.length);
  if (rows.length <= 1) return [];

  return rows.slice(1, 6).map((row, index) => {
    const cells = Array.from(row.querySelectorAll('td'));
    const cellTexts = cells.map(cell => (cell.textContent || '').trim());

    // 画像URL
    const imgElement  = row.querySelector('img');
    const imageUrl    = imgElement ? (imgElement.src || '') : '';

    // 詳細URL
    const linkElement = row.querySelector('a[href*="detail"], a[href*="vehicle"]');
    const url         = linkElement ? (linkElement.href || '') : '';

    // 車名・グレード（3〜5列目あたりから推測）
    let title = '';
    let grade = '';
    for (let i = 2; i < Math.min(cells.length, 6); i++) {
      const text = cellTexts[i];
      if (!text) continue;
      const looksNumber = /^\d+$/.test(text);
      const looksMoney  = text.includes('円');
      const looksKm     = text.includes('km');
      if (!title && !looksNumber && !looksMoney && !looksKm) {
        title = text;
      } else if (!grade && text !== title && !looksNumber && !looksMoney && !looksKm) {
        grade = text;
      }
    }

    // その他の属性をざっくり抽出
    let district = '', year = '', km = '', color = '', shift = '', rating = '', price = '';

    for (const text of cellTexts) {
      if (!price  && (text.includes('万円') || text.includes('円'))) price = text;
      if (!km     && text.includes('km')) km = text;
      if (!year   && ( /H\d{2}年/.test(text) || /20\d{2}年/.test(text) || /\d{2}年/.test(text) )) year = text;
      if (!shift  && ( text === 'MT' || text === 'AT' || text === 'CVT' || text.includes('速') )) shift = text;
      if (!rating && !text.includes('km') && !text.includes('円') && ( /^[0-9.]+$/.test(text) || text.includes('点') )) rating = text;
      if (!color  && text.length <= 5 && !/^\d+$/.test(text) && !['MT','AT','CVT'].includes(text)) color = text;
      if (!district && !/^\d+$/.test(text) && (text.includes('県') || text.includes('市') || text.length <= 4)) district = text;
    }

    return {
      title:  title || `車両 ${index + 1}`,
      grade,
      district,
      year,
      km:     km || '走行距離情報なし',
      color,
      shift,
      rating,
      price:  price || '価格情報なし',
      imageUrl,
      url
    };
  });
});

console.log('スクレイピング完了 件数:', items.length);
return items;
  
} catch (error) {
  console.error('検索エラー:', error);
  throw error;
} finally {
  try { if (page) await page.close(); }   catch (e) { console.error(e); }
  try { if (browser) await browser.close(); } catch (e) { console.error(e); }
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
        aspectRatio: '4:3',
        aspectMode: 'cover',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: item.title, weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: item.grade || 'グレード情報なし', size: 'sm', color: '#666666', margin: 'sm' },
          { type: 'separator', margin: 'md' },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'md',
            contents: [
              { type: 'text', text: '地区:', size: 'sm', color: '#555555', flex: 1 },
              { type: 'text', text: item.district || '-', size: 'sm', flex: 2 }
            ]
          },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
            contents: [
              { type: 'text', text: '年式:', size: 'sm', color: '#555555', flex: 1 },
              { type: 'text', text: item.year || '-', size: 'sm', flex: 2 }
            ]
          },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
            contents: [
              { type: 'text', text: '走行:', size: 'sm', color: '#555555', flex: 1 },
              { type: 'text', text: item.km, size: 'sm', flex: 2 }
            ]
          },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
            contents: [
              { type: 'text', text: '色:', size: 'sm', color: '#555555', flex: 1 },
              { type: 'text', text: item.color || '-', size: 'sm', flex: 2 }
            ]
          },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
            contents: [
              { type: 'text', text: 'シフト:', size: 'sm', color: '#555555', flex: 1 },
              { type: 'text', text: item.shift || '-', size: 'sm', flex: 2 }
            ]
          },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
            contents: [
              { type: 'text', text: '評価:', size: 'sm', color: '#555555', flex: 1 },
              { type: 'text', text: item.rating || '-', size: 'sm', flex: 2 }
            ]
          },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: item.price, weight: 'bold', size: 'xl', color: '#FF5551', margin: 'md', align: 'center' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '詳細を見る',
              uri: item.url || 'https://www.iauc.co.jp',
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
