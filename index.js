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
const FIELDS = ['maker','model','grade','type','budget','mileage'];
const QUESTIONS = {
  maker:   '🚗 メーカーを教えてください\n（例：スバル、アルファロメオ、ランチア）\n\n❗わからない場合は「パス」と入力\n🔄 最初からやり直す場合は「戻る」と入力',
  model:   '🚗 車名を教えてください\n（例：インプレッサ、155、デルタ）\n\n❗わからない場合は「パス」と入力\n🔄 最初からやり直す場合は「戻る」と入力',
  grade:   '⭐ グレードを教えてください\n（例：WRX、V6 TI、インテグラーレエヴォルツィオーネ）\n\n❗わからない場合は「パス」と入力\n🔄 最初からやり直す場合は「戻る」と入力',
  type:    '📋 型式を教えてください\n（例：GC8、167A1E、L31E5）\n\n❗わからない場合は「パス」と入力\n🔄 最初からやり直す場合は「戻る」と入力',
  budget:  '💰 予算上限を教えてください\n（例：100万円、500万円）\n\n🔄 最初からやり直す場合は「戻る」と入力',
  mileage: '📏 走行距離上限を教えてください\n（例：3万km、10万km）\n\n🔄 最初からやり直す場合は「戻る」と入力'
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

// 安全なナビゲーション関数
async function safeNavigation(page, url, options = {}) {
  const defaultOptions = {
    waitUntil: 'domcontentloaded', // networkidle2 → domcontentloaded に変更
    timeout: 90000 // 60秒 → 90秒に延長
  };
  
  const finalOptions = { ...defaultOptions, ...options };
  
  try {
    console.log(`ナビゲーション開始: ${url}`);
    await page.goto(url, finalOptions);
    console.log(`ナビゲーション成功: ${page.url()}`);
    return true;
  } catch (error) {
    console.log(`ナビゲーション失敗: ${error.message}`);
    console.log(`現在のURL: ${page.url()}`);
    // エラーでも現在のページで継続
    return false;
  }
}

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
async function fetchIaucResults({ maker, model, grade, type, budget, mileage }) {
  // フリーワード検索用キーワード生成
const keywords = [];
if (maker && maker !== 'パス') keywords.push(maker);
if (model && model !== 'パス') keywords.push(model);
if (grade && grade !== 'パス') keywords.push(grade);
if (type && type !== 'パス') keywords.push(type);

const keyword = keywords.join(' ');
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
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ],
      executablePath: execPath,
    });

    page = await browser.newPage();
    // タイムアウト設定を延長
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
    await page.setViewport({ width: 1280, height: 800 });

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

   // 既存セッション強制クリア（同時ログイン対策）
    console.log('既存セッションクリア中...');
    try {
      // Cookieクリア
      await page.deleteCookie(...(await page.cookies()));
      
      // LocalStorage/SessionStorageクリア
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      
      console.log('セッションクリア完了');
    } catch (e) {
      console.log('セッションクリア中にエラー:', e.message);
    }
    
    if (!(await isLoggedIn())) {
      console.log('2段階ログイン処理開始...');
      
      // STAGE 1: ログインページに直接アクセス
      console.log('STAGE 1: ログインページへ直接アクセス');
      await safeNavigation(page, 'https://www.iauc.co.jp/service/');
      
      // STAGE 1.5: 最初のログインボタンクリック
      console.log('STAGE 1.5: 最初のログインボタンクリック');
      await page.waitForSelector('a.login-btn.btn.btn-info[href*="/service/login"]', { timeout: 15000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => console.log('ナビゲーション待機タイムアウト')),
        page.click('a.login-btn.btn.btn-info[href*="/service/login"]')
      ]);

      console.log('ログインページ遷移完了:', page.url());
      
      // STAGE 2: フォーム要素が出現するまで待機（修正されたセレクタ）
      console.log('STAGE 2: ログインフォーム要素の待機');
      await page.waitForSelector('input[name="id"]', { timeout: 20000 });
      await page.waitForSelector('input[name="password"]', { timeout: 20000 });
      await page.waitForSelector('button#login_button', { timeout: 20000 });
      
      // STAGE 3: ID/パスワード入力（入力前にクリア）
      console.log('STAGE 3: ID/パスワード入力');
      
      // IDフィールドをクリアして入力
      await page.focus('input[name="id"]');
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.type('input[name="id"]', uid, { delay: 40 });
      
      // パスワードフィールドをクリアして入力
      await page.focus('input[name="password"]');
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.type('input[name="password"]', pw, { delay: 40 });
      
      // STAGE 4: ログインボタンクリック
      console.log('STAGE 4: ログインボタンクリック');
      await page.click('button#login_button');
      
      // STAGE 5: ログイン成功判定（複数条件での並行待機）
      console.log('STAGE 5: ログイン成功判定');
      
      await Promise.race([
        page.waitForSelector('a[href*="/service/logout"]', { timeout: 45000 }),
        page.waitForFunction(() => location.href.includes('/vehicle/'), { timeout: 45000 })
      ]).catch(() => {
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
        const navSuccess = await safeNavigation(page, 'https://www.iauc.co.jp/vehicle/', { timeout: 45000 });
        
        if (!navSuccess) {
          const debugInfo = await page.evaluate(() => ({
            title: document.title,
            bodyPreview: document.body.innerText.substring(0, 500)
          }));
          console.log('ログイン失敗デバッグ情報:', debugInfo);
          throw new Error('ログインに失敗しました（vehicle ページへの遷移も失敗）');
        }
      }
      
      console.log('ログイン完了！');
    } else {
      console.log('既にログイン済み');
    }
    
    // 会場選択ページへ（安定化処理）
    console.log('会場選択ページへ移動中...');
    const vehicleNavSuccess = await safeNavigation(page, 'https://www.iauc.co.jp/vehicle/', { timeout: 60000 });
    
    if (!vehicleNavSuccess) {
      console.log('会場選択ページ遷移に失敗、現在のページで処理継続');
      // 現在のページで処理を継続
    }
    
    console.log('現在のページURL:', page.url(), 'title:', await page.title());

   // セッション安定化のため長めに待機（同時ログイン対策）
    await sleep(10000);

// --- お知らせ/モーダル自動クローズ → 検索UIへ復旧 ---
    console.log('お知らせ画面・モーダルの確認中...');

    // モーダル/オーバーレイの閉じるボタンを探してクリック
    const closeButtonSelectors = [
      'button:contains("閉じる")', 'button:contains("×")', 'button:contains("OK")',
      '.close', '.btn-close', '.modal-close', '[aria-label="close"]',
      '.overlay-close', '.popup-close', '.notice-close'
    ];

    for (const selector of closeButtonSelectors) {
      try {
        if (selector.includes(':contains')) {
          const buttons = await page.$$('button, a, span');
          for (const button of buttons) {
            const text = await page.evaluate(btn => btn.textContent, button);
            if (text && (text.includes('閉じる') || text.includes('×') || text.includes('OK'))) {
              console.log('お知らせ閉じるボタン発見、クリック中...');
              await button.click();
              await sleep(2000);
              break;
            }
          }
        } else {
          const closeBtn = await page.$(selector);
          if (closeBtn) {
            console.log('モーダル閉じるボタン発見:', selector);
            await closeBtn.click();
            await sleep(2000);
            break;
          }
        }
      } catch (e) {
        // エラーは無視して次へ
      }
    }

    // UI要素の確認
    const uiSelectors = ['#btn_vehicle_everyday_all', '#vehicle_everyday .checkbox_on_all', '#btn_vehicle_day_all'];
    let uiFound = false;
    for (const s of uiSelectors) { 
      const el = await page.$(s);
      if (el) { 
        uiFound = true; 
        break; 
      } 
    }

    if (!uiFound) {
      console.log('UI要素が見つからない、インフォメーション画面の可能性あり');
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
          await sleep(5000); // ナビゲーション待機を固定時間に
          console.log('復旧後URL:', page.url());
        } else {
          // 直接 vehicle 再ロード
          await safeNavigation(page, 'https://www.iauc.co.jp/vehicle/');
        }
      }
    }

    // 改良された safeClick 関数
    async function safeClick(selectors, timeout = 60000) {
      const sels = Array.isArray(selectors) ? selectors : [selectors];
      const start = Date.now();

      while (Date.now() - start < timeout) {
        // メインページで試行
        for (const s of sels) {
          try {
            const el = await page.$(s);
            if (el) {
              console.log(`要素発見（メインページ）: ${s}`);
              await page.click(s);
              await sleep(1000);
              return true;
            }
          } catch (e) {
            // 個別要素エラーは無視して次を試行
          }
        }
        
        // フレーム内で試行（メインで見つからない場合のみ）
        for (const s of sels) {
          for (const f of page.frames()) {
            try {
              const el = await f.$(s);
              if (el) {
                console.log(`要素発見（フレーム内）: ${s}`);
                await f.click(s);
                await sleep(1000);
                return true;
              }
            } catch (e) {
              // フレームエラーは無視
            }
          }
        }
        
        await sleep(1000);
      }

      // デバッグ出力
      console.log('要素が見つからない、現在のページ状態をデバッグ');
      try {
        const candidates = await page.$$eval('a[id^="btn_vehicle_"], button, .btn',
          els => els.slice(0, 10).map(e => ({ 
            tag: e.tagName, 
            id: e.id, 
            className: e.className, 
            text: (e.textContent||'').trim().substring(0, 50) 
          })));
        console.log('見つかった候補要素:', candidates);
      } catch {}
      
      console.log(`警告: セレクタが見つかりませんでした: ${sels.join(', ')}`);
      return false; // エラーではなく false を返す
    }

    // 共有在庫＆一発落札「全選択」
    console.log('共有在庫の全選択中...');
    const everydaySuccess = await safeClick([
      '#btn_vehicle_everyday_all',
      '#vehicle_everyday .checkbox_on_all',
      'a.title-green-button.checkbox_on_all[data-target="#vehicle_everyday"]'
    ], 45000);

    if (!everydaySuccess) {
      console.log('共有在庫全選択に失敗、処理を継続');
    }

    // オークション＆入札会「全選択」
    console.log('オークション&入札会の全選択中...');
    const daySuccess = await safeClick([
      '#btn_vehicle_day_all',
      '#vehicle_day .checkbox_on_all',
      'a.title-button.checkbox_on_all[data-target="#vehicle_day"]'
    ], 45000);

    if (!daySuccess) {
      console.log('オークション全選択に失敗、処理を継続');
    }

    // 「次へ」
    console.log('次へボタンをクリック中...');
    const nextSuccess = await safeClick([
      'button.page-next-button[onclick*="check_sites"]',
      'button.page-next-button',
      '.page-next-button'
    ], 45000);

   if (nextSuccess) {
      // ナビゲーション待機（エラー耐性あり）
      try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('次へボタン後の遷移完了');
      } catch (navError) {
        console.log('次へボタン後の遷移待機タイムアウト、処理継続');
      }
      // フリーワード検索タブが表示されるまで十分待機
      await sleep(10000);
      console.log('フリーワード検索タブ表示待機完了');
    } else {
      console.log('次へボタンが見つからない、現在のページで処理継続');
    }
    
    // フリーワード検索タブ - 改良版
    console.log('フリーワード検索実行中...');
    
    // 現在のページ状態をデバッグ
    const currentUrl2 = page.url();
    console.log('フリーワード検索前URL:', currentUrl2);
    
    // フリーワード検索タブクリック（より確実な待機付き）
    console.log('フリーワード検索タブ要素確認中...');
    await page.waitForSelector('#button_freeword_search', { timeout: 20000 }).catch(() => {
      console.log('フリーワード検索タブ待機タイムアウト');
    });
    
    const freewordTabSuccess = await safeClick([
      '#button_freeword_search', 
      'a#button_freeword_search', 
      'a[href="#freeword"]#button_freeword_search',
      'a[href*="freeword"]'
    ], 30000);
    
    if (!freewordTabSuccess) {
      console.log('フリーワード検索タブが見つからない、別の方法を試行');
    }
    
    // クリック後の待機
    await sleep(2000);
    
    // フリーワード入力フィールドを探す
    const freewordSelectors = [
      'input[name="freeword"]',
      'input[name="freeword_search"]', 
      'input[type="text"]',
      '#freeword',
      '.freeword-input'
    ];
    
    let inputFound = false;
    for (const selector of freewordSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          console.log('入力フィールド発見:', selector);
          
          // キーワード入力
          console.log('キーワード入力中:', keyword);
          await page.focus(selector);
          await page.type(selector, keyword, { delay: 50 });
          inputFound = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!inputFound) {
      console.log('入力フィールドが見つからない');
      // デバッグ情報
      const inputDebug = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(input => ({
          name: input.name,
          type: input.type,
          id: input.id,
          visible: input.offsetParent !== null
        }));
      });
      console.log('見つかった入力フィールド:', inputDebug);
      throw new Error('フリーワード入力フィールドが見つかりません');
    }
    
    // 検索実行
    console.log('検索実行中...');
    const searchButtonSelectors = [
      'button.button.corner-radius',
      'button[type="submit"]',
      'input[value="検索"]',
      '.search-button',
      'button:contains("検索")'
    ];
    
    let searchExecuted = false;
    for (const btnSelector of searchButtonSelectors) {
      try {
        if (btnSelector.includes(':contains')) {
          const buttons = await page.$$('button, input[type="submit"]');
          for (const button of buttons) {
            const text = await page.evaluate(btn => btn.textContent || btn.value, button);
            if (text && text.includes('検索')) {
              await button.click();
              searchExecuted = true;
              console.log('検索ボタンクリック完了（テキストベース）');
              break;
            }
          }
        } else {
          const btn = await page.$(btnSelector);
          if (btn) {
            console.log('検索ボタン発見:', btnSelector);
            await btn.click();
            searchExecuted = true;
            break;
          }
        }
        if (searchExecuted) break;
      } catch (e) {
        continue;
      }
    }
    
    if (!searchExecuted) {
      console.log('検索ボタンが見つからないため、Enterキーで実行');
      await page.keyboard.press('Enter');
    }
    
    // 検索結果ページ遷移待機（エラー耐性強化）
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 });
      console.log('検索結果ページに遷移完了');
    } catch (error) {
      console.log('検索結果ページ遷移待機タイムアウト、現在のページで継続');
      await sleep(5000);
    }
    
    // 結果行が描画されるまで待つ（エラー耐性あり）
    try {
      await page.waitForSelector('tbody tr', { timeout: 20000 });
      console.log('検索結果テーブル発見');
    } catch (e) {
      console.log('検索結果テーブル待機タイムアウト');
    }

    // 「結果」ボタンをクリックしてフィルタダイアログを開く
    console.log('「結果」ボタンをクリック中...');
    const resultButtonSelectors = [
      'a.narrow_button.result',
      '[data-element="transactionStatusId"]',
      'a[title*="絞り込み"]'
    ];
    
    let resultButtonFound = false;
    for (const selector of resultButtonSelectors) {
      const resultButton = await page.$(selector);
      if (resultButton) {
        console.log('結果ボタン発見:', selector);
        await resultButton.click();
        resultButtonFound = true;
        break;
      }
    }
    
    if (!resultButtonFound) {
      console.log('結果ボタンが見つかりません');
    }
    
    // フィルタダイアログの待機
    await sleep(2000);
    
    // 業販車のみ選択（仮出品・未せり・申込可）
    console.log('業販車フィルタを選択中...');
    
    await page.evaluate(() => {
      // 全てのチェックボックスを一旦クリア
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      checkboxes.forEach(cb => {
        if (cb.checked) cb.click();
      });
      
      // 必要な項目のみ選択
      const targetCheckboxes = [
  'input[type="checkbox"][value="1"]',   // 仮出品
  'input[type="checkbox"][value="2"]',   // 未せり  
  'input[type="checkbox"][value="11"]'   // 申込可
];

for (const selector of targetCheckboxes) {
  const checkbox = document.querySelector(selector);
  if (checkbox && !checkbox.checked) {
    checkbox.click();
    console.log(`チェックボックス選択: ${selector}`);
  }
}
    });
    
    // OKボタンをクリック
    console.log('OKボタンをクリック中...');
    const okButtonSelectors = [
  'a#narrow_button',
  '#narrow_button',
  'button.narrow_button'
];
    
    let okButtonFound = false;
    for (const selector of okButtonSelectors) {
      try {
        if (selector.includes(':contains')) {
          const buttons = await page.$$('button, input[type="submit"]');
          for (const button of buttons) {
            const text = await page.evaluate(btn => btn.textContent || btn.value, button);
            if (text && text.includes('OK')) {
              await button.click();
              okButtonFound = true;
              console.log('OKボタンクリック完了');
              break;
            }
          }
        } else {
          const okBtn = await page.$(selector);
          if (okBtn) {
            await okBtn.click();
            okButtonFound = true;
            console.log('OKボタンクリック完了:', selector);
            break;
          }
        }
        if (okButtonFound) break;
      } catch (e) {
        console.log('OKボタンセレクタ失敗:', selector);
      }
    }
    
    if (!okButtonFound) {
      console.log('OKボタンが見つからないため、Enterキーで確定');
      await page.keyboard.press('Enter');
    }
    
    // フィルタ適用後の待機
    await sleep(3000);
    
    // 正確なセレクタでスクレイピング実行
   const items = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('tr[data-lid]'));
  console.log('発見した行数:', rows.length);
  
  if (rows.length <= 1) return [];
  
  return rows.slice(0, 10).map((row, index) => {
    const imageEl = row.querySelector('img.img-carlazy-table');
    const nameEl = row.querySelector('td.col1.open-detail');
    const venueEl = row.querySelector('td.col4.open-detail');
    const mileageEl = row.querySelector('td.col7.open-detail');
    const colorEl = row.querySelector('td.col8.open-detail');
    const priceEl = row.querySelector('td.col11.open-detail');
    
    return {
      title: nameEl ? nameEl.textContent.trim() : `車両 ${index + 1}`,
      imageUrl: imageEl ? imageEl.src : '',
      venue: venueEl ? venueEl.textContent.trim() : '会場情報なし',
      km: mileageEl ? mileageEl.textContent.trim() : '走行距離情報なし',
      color: colorEl ? colorEl.textContent.trim() : '色情報なし',
      price: priceEl ? priceEl.textContent.trim() : '価格情報なし',
      url: row.querySelector('a') ? row.querySelector('a').href : ''
    };
  });
});

    console.log('業販車スクレイピング完了 件数:', items.length);
    return items;
  
  } catch (error) {
    console.error('検索エラー:', error);
    console.error('スタックトレース:', error.stack);
    throw error;
  } finally {
    try { if (page) await page.close(); }   catch (e) { console.error(e); }
    try { if (browser) await browser.close(); } catch (e) { console.error(e); }
  }
}

async function handleEvent(event) {
  console.log('イベント受信:', event.type, event.message?.type);
  
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const uid   = event.source.userId;
  const text  = event.message.text.trim();
  const token = event.replyToken;

  console.log('ユーザーID:', uid);
  console.log('受信テキスト:', text);

  // 「戻る」コマンドで最初から
  if (text === '戻る') {
    sessions.delete(uid);
    return client.replyMessage(token, {
      type: 'text',
      text: '🔄 最初からやり直します。\n\n' + QUESTIONS.maker
    });
  }

  // 初回質問
  if (!sessions.has(uid)) {
    console.log('新規セッション開始');
    sessions.set(uid, { step: 0, data: {} });
    return client.replyMessage(token, { type:'text', text: QUESTIONS.maker });
  }

  // 回答保存＆次へ
  const session = sessions.get(uid);
  const field   = FIELDS[session.step];
  session.data[field] = (text === 'パス') ? '' : text;
  session.step++;

  console.log('セッション更新:', session);

  // 次の質問
  if (session.step < FIELDS.length) {
    const nextField = FIELDS[session.step];
    return client.replyMessage(token, { type:'text', text: QUESTIONS[nextField] });
  }
 
  // 終了メッセージ
  console.log('検索開始 - 収集した条件:', session.data);
  await client.replyMessage(token, {
    type: 'text',
    text: '✅ 検索条件を受け付けました！\n\n🔍 IAucで検索中...\n（約30秒お待ちください）'
  });

  try {
    // IAuc 検索実行
    console.log('IAuc検索を開始...');
    const results = await fetchIaucResults(session.data);
    console.log('検索結果:', results?.length || 0, '件');

    // 0件ならテキスト通知して終了
    if (!results || results.length === 0) {
      console.log('検索結果が0件でした');
      await client.pushMessage(uid, {
        type: 'text',
        text: '該当する車両が見つかりませんでした。検索キーワードを変更してもう一度お試しください。'
      });
      sessions.delete(uid);
      return;
    }

    // Flex メッセージ用バブル生成
    console.log('Flexメッセージを生成中...');
    const bubbles = results.slice(0,5).map(item => ({
      type: 'bubble',
      hero: {
        type: 'image',
        url: item.imageUrl || 'https://via.placeholder.com/240x180?text=車両画像',
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
    console.log('検索結果を送信中...');
    await client.pushMessage(uid, {
      type: 'flex',
      altText: 'IAuc 検索結果はこちらです',
      contents: {
        type: 'carousel',
        contents: bubbles,
      },
    });
    console.log('検索結果送信完了');

  } catch (error) {
    console.error('検索処理でエラーが発生:', error);
    console.error('スタックトレース:', error.stack);
    
    await client.pushMessage(uid, {
      type: 'text',
      text: 'エラーが発生しました。しばらく経ってから再度お試しください。'
    }).catch(console.error);
  } finally {
    // 会話セッションをクリア
    console.log('セッションをクリア');
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
