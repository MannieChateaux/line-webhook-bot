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
      await page.goto('https://www.iauc.co.jp/service/', { waitUntil: 'domcontentloaded' });
      
      // STAGE 1.5: 最初のログインボタンクリック
      console.log('STAGE 1.5: 最初のログインボタンクリック');
      await page.waitForSelector('a.login-btn.btn.btn-info[href*="/service/login"]', { timeout: 10000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
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
        page.waitForSelector('a[href*="/service/logout"]', { timeout: 30000 }),
        page.waitForFunction(() => location.href.includes('/vehicle/'), { timeout: 30000 })
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

    // フリーワード検索タブ - デバッグ強化版
    console.log('フリーワード検索実行中...');
    
    // 現在のページ状態をデバッグ
    const currentUrl = page.url();
    console.log('現在のURL:', currentUrl);
    
    // フリーワード検索タブクリック前の状態確認
    const tabExists = await page.evaluate(() => {
      const tab = document.querySelector('#button_freeword_search');
      return {
        exists: !!tab,
        visible: tab ? tab.offsetParent !== null : false,
        text: tab ? tab.textContent : null
      };
    });
    console.log('フリーワード検索タブ状態:', tabExists);
    
    // タブクリック実行
    await safeClick(['#button_freeword_search', 'a#button_freeword_search', 'a[href="#freeword"]#button_freeword_search']);
    
    // クリック後の待機
    await sleep(1000);
    
    // 入力フィールド候補を全て確認
    console.log('入力フィールド候補を確認中...');
    const inputFields = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.map(input => ({
        name: input.name,
        type: input.type,
        id: input.id,
        className: input.className,
        visible: input.offsetParent !== null,
        placeholder: input.placeholder
      }));
    });
    console.log('見つかった入力フィールド:', inputFields);
    
    // フリーワード入力フィールドを複数候補で試行
    const freewordSelectors = [
      'input[name="freeword"]',
      'input[name="freeword_search"]', 
      'input[type="text"]',
      '#freeword',
      '.freeword-input'
    ];
    
    let inputFound = false;
    for (const selector of freewordSelectors) {
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
    }
    
    if (!inputFound) {
      console.log('入力フィールドが見つかりません。ページのスクリーンショットを保存...');
      await page.screenshot({ path: '/tmp/freeword_input_error.png', fullPage: true }).catch(() => {});
      throw new Error('フリーワード入力フィールドが見つかりません');
    }
    
    // 検索実行
    console.log('検索実行中...');
    const searchButton = await page.$('button.button.corner-radius');
    if (searchButton) {
      await searchButton.click();
    } else {
      // 他の検索ボタン候補も試行
      const buttonSelectors = [
        'button[type="submit"]',
        'input[value="検索"]',
        'button:contains("検索")',
        '.search-button'
      ];
      
      let buttonFound = false;
      for (const btnSelector of buttonSelectors) {
        const btn = await page.$(btnSelector);
        if (btn) {
          console.log('検索ボタン発見:', btnSelector);
          await btn.click();
          buttonFound = true;
          break;
        }
      }
      
      if (!buttonFound) {
        console.log('検索ボタンが見つからないため、Enterキーで実行');
        await page.keyboard.press('Enter');
      }
    }
    
    // 検索結果ページ遷移待機
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      console.log('検索結果ページに遷移完了');
    } catch (error) {
      console.log('ナビゲーション待機タイムアウト（続行）');
    }
    
    // 結果行が描画されるまで待つ
    await page.waitForSelector('tbody tr', { timeout: 15000 }).catch(()=>{});

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
      const targetLabels = ['仮出品', '未せり', '申込可'];
      
      for (const label of targetLabels) {
        // ラベルテキストから該当するチェックボックスを探す
        const labels = Array.from(document.querySelectorAll('label'));
        const targetLabel = labels.find(l => l.textContent && l.textContent.includes(label));
        
        if (targetLabel) {
          // ラベルに対応するチェックボックスを探す
          const checkbox = targetLabel.querySelector('input[type="checkbox"]') ||
                          document.querySelector(`input[id="${targetLabel.getAttribute('for')}"]`);
          
          if (checkbox && !checkbox.checked) {
            checkbox.click();
            console.log(`${label} を選択しました`);
          }
        }
      }
    });
    
    // OKボタンをクリック
    console.log('OKボタンをクリック中...');
    const okButtonSelectors = [
      'button:contains("OK")',
      'input[value="OK"]',
      '.btn:contains("OK")',
      'button.btn'
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
    console.log('正確なセレクタで業販車情報をスクレイピング中...');
    const items = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tbody tr'));
      console.log('フィルタ後の行数:', rows.length);
      
      if (rows.length <= 1) return [];
      
      const vehicles = [];
      
      for (let i = 1; i < rows.length && vehicles.length < 10; i++) {
        const row = rows[i];
        
        // 各データを正確なセレクタで取得
        const vehicleName = row.querySelector('[data-element="vehicleName"]')?.textContent?.trim() || '';
        const grade = row.querySelector('[data-element="grade"]')?.textContent?.trim() || '';
        const sfield = row.querySelector('[data-element="sfield"]')?.textContent?.trim() || '';
        const district = row.querySelector('[data-element="district"]')?.textContent?.trim() || '';
        const modelYear = row.querySelector('[data-element="modelOfYear"]')?.textContent?.trim() || '';
        const type = row.querySelector('[data-element="type"]')?.textContent?.trim() || '';
        const mileage = row.querySelector('[data-element="mileage"]')?.textContent?.trim() || '';
        const startPrice = row.querySelector('[data-element="startPrice"]')?.textContent?.trim() || '';
        const transactionStatus = row.querySelector('[data-element="transactionStatusId"]')?.textContent?.trim() || '';
        
        // 車両画像
        const imgElement = row.querySelector('img.img-car.lazy-table.visited');
        const imageUrl = imgElement ? imgElement.src : '';
        
        // 詳細リンク（data-lid属性から構築）
        const dataLid = row.getAttribute('data-lid');
        const url = dataLid ? `https://www.iauc.co.jp/vehicle/detail/${dataLid}` : '';
        
        // 価格から数値抽出（ソート用）
        const priceMatch = startPrice.match(/(\d+(?:\.\d+)?)/);
        const priceNum = priceMatch ? parseFloat(priceMatch[1]) : 999999;
        
        vehicles.push({
          title: vehicleName || `車両 ${vehicles.length + 1}`,
          grade: grade,
          sfield: sfield,
          district: district,
          year: modelYear,
          type: type,
          km: mileage || '走行距離情報なし',
          price: startPrice || '価格情報なし',
          status: transactionStatus,
          imageUrl: imageUrl,
          url: url,
          priceNum: priceNum
        });
      }
      
      // 価格順でソート（安い順）
      vehicles.sort((a, b) => a.priceNum - b.priceNum);
      
      console.log('スクレイピング完了:', vehicles.length, '件');
      return vehicles.slice(0, 5); // 上位5件のみ
    });

    console.log('業販車スクレイピング完了 件数:', items.length);
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
    text: '✅ 条件が揃いました。業販価格の車両を検索中…少々お待ちください！'
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
        text: '該当する業販価格の車両が見つかりませんでした。検索キーワードを変更してもう一度お試しください。'
      });
      sessions.delete(uid);
      return;
    }

    // Flex メッセージ用バブル生成（縦型カード）
    console.log('🎨 業販車Flexメッセージを生成中...');
    const bubbles = results.map(item => ({
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
          { 
            type: 'text', 
            text: item.title, 
            weight: 'bold', 
            size: 'lg', 
            wrap: true,
            maxLines: 2
          },
          { 
            type: 'text', 
            text: item.grade || 'グレード情報なし', 
            size: 'sm', 
            color: '#666666', 
            margin: 'sm',
            wrap: true
          },
          { type: 'separator', margin: 'md' },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'md',
            contents: [
              { type: 'text', text: '会場:', size: 'sm', color: '#555555', flex: 1 },
              { type: 'text', text: item.sfield || '-', size: 'sm', flex: 2, wrap: true }
            ]
          },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
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
              { type: 'text', text: item.km, size: 'sm', flex: 2, wrap: true }
            ]
          },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
            contents: [
              { type: 'text', text: '型式:', size: 'sm', color: '#555555', flex: 1 },
              { type: 'text', text: item.type || '-', size: 'sm', flex: 2 }
            ]
          },
          { 
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
            contents: [
              { type: 'text', text: '状態:', size: 'sm', color: '#555555', flex: 1 },
              { type: 'text', text: item.status || '申込可', size: 'sm', flex: 2, color: '#22C55E' }
            ]
          },
          { type: 'separator', margin: 'md' },
          { 
            type: 'text', 
            text: item.price, 
            weight: 'bold', 
            size: 'xl', 
            color: '#FF5551', 
            margin: 'md', 
            align: 'center',
            wrap: true
          },
          {
            type: 'text',
            text: '✅ 業販価格で即購入可能',
            size: 'xs',
            color: '#22C55E',
            align: 'center',
            margin: 'sm'
          }
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
            color: '#22C55E',
            action: {
              type: 'uri',
              label: '詳細を見る',
              uri: item.url || 'https://www.iauc.co.jp',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: 'この車を購入したい',
              text: `${item.title}の購入を希望します`
            }
          }
        ],
      },
    }));
   
    // Flex メッセージで検索結果を返信
    console.log('📤 業販車検索結果を送信中...');
    
    // ヘッダーメッセージ
    await client.pushMessage(uid, {
      type: 'text',
      text: `🚗 業販価格車両が${results.length}件見つかりました！\n💰 価格安い順に表示しています\n✅ すべて即購入可能な車両です`
    });
    
    // Flexメッセージ
    await client.pushMessage(uid, {
      type: 'flex',
      altText: '業販価格車両検索結果',
      contents: {
        type: 'carousel',
        contents: bubbles,
      },
    });
    
    // フッターメッセージ
    await client.pushMessage(uid, {
      type: 'text',
      text: '📋 購入をご希望の場合は「この車を購入したい」ボタンを押してください\n🔄 別の条件で検索したい場合は、新しいキーワードを送信してください'
    });
    
    console.log('✅ 業販車検索結果送信完了');

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
