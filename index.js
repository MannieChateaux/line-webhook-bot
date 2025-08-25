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
    const needsLogin = await page.$('#userid') || await page.$('input[name=userid]') || 
                       await page.$('.login-form') || await page.$('#login') ||
                       page.url().includes('login') || await page.$('input[type="password"]');
    
    if (needsLogin || page.url().includes('iauc.co.jp/vehicle/')) {
      console.log('🔑 ログインが必要です。ログイン処理を開始...');
      
     if (!page.url().includes('login')) {
  console.log('🔄 ログインページに移動中...');
  // まずトップページにアクセスしてからログインリンクを探す
  await page.goto('https://www.iauc.co.jp/', { waitUntil: 'domcontentloaded' });
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // ログインリンクを探してクリック
  const loginLinkSelectors = [
    'a[href*="login"]', 
    'a[href*="service/login"]',
    'a:contains("ログイン")',
    '.login-link',
    '#login-link'
  ];
  
  let loginFound = false;
  for (const selector of loginLinkSelectors) {
    try {
      if (selector.includes(':contains')) {
        const links = await page.$$('a');
        for (const link of links) {
          const text = await page.evaluate(l => l.textContent, link);
          if (text && text.includes('ログイン')) {
            await link.click();
            loginFound = true;
            break;
          }
        }
      } else {
        const loginLink = await page.$(selector);
        if (loginLink) {
          await loginLink.click();
          loginFound = true;
          break;
        }
      }
      if (loginFound) break;
    } catch (e) {
      continue;
    }
  }
  
  if (loginFound) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
  } else {
    console.log('⚠️ ログインリンクが見つかりません');
  }
}
      
      try {
  await page.waitForSelector('#userid, input[name=userid], input[name="user"], input[type="text"]', { timeout: 5000 });
} catch (e) {
  console.log('⚠️ ユーザーIDフィールドが見つかりません、ページ構造をデバッグします');
  const loginElements = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(el => ({
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder
    }));
  });
  console.log('🔍 ログインページの入力要素:', JSON.stringify(loginElements, null, 2));
}

try {
  await page.waitForSelector('#password, input[name=password], input[type="password"]', { timeout: 5000 });
} catch (e) {
  console.log('⚠️ パスワードフィールドが見つかりません');
}

      const uid = process.env.IAUC_USER_ID;
      const pw  = process.env.IAUC_PASSWORD;
      
      if (!uid || !pw) {
        console.error('❌ IAUC認証情報が設定されていません');
        throw new Error('IAUC_USER_ID / IAUC_PASSWORD not set');
      }

      console.log('📝 ログイン情報を入力中...');
      // 複数のセレクタでユーザーID入力を試行
      const userSelectors = ['#userid', 'input[name=userid]', 'input[name="user"]', 'input[type="text"]:first-of-type'];
      for (const selector of userSelectors) {
        const userField = await page.$(selector);
        if (userField) {
          await page.type(selector, uid, { delay: 50 });
          console.log('✅ ユーザーID入力完了:', selector);
          break;
        }
      }

      // 複数のセレクタでパスワード入力を試行
      const passSelectors = ['#password', 'input[name=password]', 'input[type="password"]'];
      for (const selector of passSelectors) {
        const passField = await page.$(selector);
        if (passField) {
          await page.type(selector, pw, { delay: 50 });
          console.log('✅ パスワード入力完了:', selector);
          break;
        }
      }

      console.log('🚪 ログインボタンをクリック...');
      // ログインボタンを複数パターンで検索
      const loginButtonSelectors = [
        'input[type=submit]', 'button[type=submit]', 'button:contains("ログイン")',
        '.login-btn', '#login-btn', 'input[value*="ログイン"]', 'button'
      ];
      
      let loginClicked = false;
      for (const selector of loginButtonSelectors) {
        try {
          if (selector.includes(':contains')) {
            const buttons = await page.$$('button, input[type="submit"]');
            for (const button of buttons) {
              const text = await page.evaluate(btn => btn.textContent || btn.value, button);
              if (text && text.includes('ログイン')) {
                await button.click();
                loginClicked = true;
                console.log('✅ ログインボタンクリック完了（テキストベース）');
                break;
              }
            }
          } else {
            const loginBtn = await page.$(selector);
            if (loginBtn) {
              await loginBtn.click();
              loginClicked = true;
              console.log('✅ ログインボタンクリック完了:', selector);
              break;
            }
          }
          if (loginClicked) break;
        } catch (e) {
          console.log('⚠️ ログインボタンセレクタ失敗:', selector);
        }
      }

      if (!loginClicked) {
        console.log('⚠️ ログインボタンが見つからないため、Enterキーで送信');
        await page.keyboard.press('Enter');
      }

     console.log('⏳ ログイン処理完了を待機中...');
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        console.log('✅ ログイン完了');
        
        // 現在のURLを確認
        const currentUrl = page.url();
        console.log('🌐 ログイン後のURL:', currentUrl);
        
        // 検索フォームが利用可能なページを探す
        const searchPageUrls = [
          'https://www.iauc.co.jp/search/',
          'https://www.iauc.co.jp/vehicle/search/',
          'https://www.iauc.co.jp/member/vehicle/',
          currentUrl // 現在のページもチェック
        ];
        
        let foundSearchForm = false;
        for (const url of searchPageUrls) {
          try {
            if (url !== currentUrl) {
              console.log('🔍 検索ページを試行:', url);
              await page.goto(url, { waitUntil: 'domcontentloaded' });
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // 検索フォーム要素の存在確認
            const hasForm = await page.evaluate(() => {
              return document.querySelectorAll('select, input[type="text"], input[type="number"]').length > 3;
            });
            
            if (hasForm) {
              console.log('✅ 検索フォーム発見:', page.url());
              foundSearchForm = true;
              break;
            }
          } catch (e) {
            console.log('⚠️ URL試行失敗:', url);
          }
        }
        
        if (!foundSearchForm) {
          console.log('⚠️ 適切な検索ページが見つかりません');
        }
        
      } catch (navError) {
        console.log('⚠️ ナビゲーション待機タイムアウト、現在のページで継続');
      }
    } else {
      console.log('ℹ️ ログイン不要です');
    }
    
    // 3) ページが完全にロードされるまで待機
    console.log('🔍 ページの完全ロードを待機中...');
    await new Promise(resolve => setTimeout(resolve, 3000)); // 3秒待機
    
    // 実際のページのHTML構造を詳細調査
    console.log('🔍 現在のページのHTML構造をデバッグ中...');
    const pageTitle = await page.title();
    console.log('📄 ページタイトル:', pageTitle);
    
    const finalUrl = page.url();
    console.log('🌐 現在のURL:', finalUrl);
    
    // ページ全体のHTMLを一部取得（デバッグ用）
    const bodyHTML = await page.evaluate(() => {
      return document.body.innerHTML.substring(0, 2000); // 最初の2000文字
    });
    console.log('📝 BODY HTML（一部）:', bodyHTML);
    
    // フォーム関連要素をすべて検索
    const formElements = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select')).map(el => ({
        tag: 'select',
        name: el.name || '',
        id: el.id || '',
        className: el.className || '',
        options: Array.from(el.options).slice(0, 3).map(opt => opt.textContent?.trim())
      }));
      
      const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
        tag: 'input',
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        className: el.className || '',
        placeholder: el.placeholder || ''
      }));
      
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        className: el.className || '',
        text: el.textContent?.trim() || el.value || ''
      }));
      
      return { selects, inputs, buttons };
    });
    
    console.log('🎯 発見した要素:');
    console.log('📝 SELECT要素:', JSON.stringify(formElements.selects, null, 2));
    console.log('📝 INPUT要素:', JSON.stringify(formElements.inputs, null, 2));
    console.log('📝 BUTTON要素:', JSON.stringify(formElements.buttons, null, 2));
    
    // より柔軟な要素検索を試す
    const hasAnyFormElements = await page.evaluate(() => {
      return {
        hasSelects: document.querySelectorAll('select').length > 0,
        hasInputs: document.querySelectorAll('input').length > 0,
        hasButtons: document.querySelectorAll('button, input[type="submit"]').length > 0,
        totalForms: document.querySelectorAll('form').length
      };
    });
    
    console.log('🎯 フォーム要素の存在確認:', hasAnyFormElements);
    
    if (!hasAnyFormElements.hasSelects && !hasAnyFormElements.hasInputs) {
      console.log('⚠️ フォーム要素が見つからないため、ページのスクリーンショットを取得');
      await page.screenshot({ path: 'debug_page.png', fullPage: true }).catch(console.error);
      throw new Error('検索フォームが見つかりません。サイト構造が変更された可能性があります。');
    }
    
    console.log('✅ デバッグ情報取得完了');
    
   // 4) 検索フォーム要素を動的に検出して入力
    console.log('📊 検索条件を動的に入力中...');
    
    // より柔軟な要素検索・入力処理
    await page.evaluate((searchData) => {
      console.log('🔍 ページ内で要素を検索中...', searchData);
      
      // メーカー入力（select要素を複数パターンで検索）
      const makerSelectors = ['select[name*="maker"]', 'select[id*="maker"]', 'select[class*="maker"]', 'select:first-of-type'];
      let makerSelect = null;
      for (const selector of makerSelectors) {
        makerSelect = document.querySelector(selector);
        if (makerSelect) {
          console.log('✅ メーカーselect発見:', selector);
          break;
        }
      }
      
      if (makerSelect && searchData.maker) {
        const options = Array.from(makerSelect.options);
        const matchOption = options.find(opt => 
          opt.textContent.includes(searchData.maker) || 
          opt.value.toLowerCase().includes(searchData.maker.toLowerCase())
        );
        if (matchOption) {
          makerSelect.value = matchOption.value;
          makerSelect.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('✅ メーカー設定完了:', searchData.maker);
        }
      }
      
      // 車種入力
      const modelSelectors = ['select[name*="model"]', 'select[id*="model"]', 'select[class*="model"]'];
      let modelSelect = null;
      for (const selector of modelSelectors) {
        modelSelect = document.querySelector(selector);
        if (modelSelect) {
          console.log('✅ 車種select発見:', selector);
          break;
        }
      }
      
      if (modelSelect && searchData.model) {
        const options = Array.from(modelSelect.options);
        const matchOption = options.find(opt => 
          opt.textContent.includes(searchData.model) || 
          opt.value.toLowerCase().includes(searchData.model.toLowerCase())
        );
        if (matchOption) {
          modelSelect.value = matchOption.value;
          modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('✅ 車種設定完了:', searchData.model);
        }
      }
      
      // 予算入力（input要素を複数パターンで検索）
      const budgetSelectors = ['input[name*="budget"]', 'input[id*="budget"]', 'input[class*="budget"]', 'input[placeholder*="予算"]', 'input[type="number"]'];
      let budgetInput = null;
      for (const selector of budgetSelectors) {
        budgetInput = document.querySelector(selector);
        if (budgetInput) {
          console.log('✅ 予算input発見:', selector);
          break;
        }
      }
      
      if (budgetInput && searchData.budgetNum) {
        budgetInput.value = searchData.budgetNum;
        budgetInput.dispatchEvent(new Event('input', { bubbles: true }));
        console.log('✅ 予算設定完了:', searchData.budgetNum);
      }
      
      // 走行距離入力
      const mileageSelectors = ['input[name*="mileage"]', 'input[id*="mileage"]', 'input[class*="mileage"]', 'input[placeholder*="走行距離"]'];
      let mileageInput = null;
      for (const selector of mileageSelectors) {
        mileageInput = document.querySelector(selector);
        if (mileageInput) {
          console.log('✅ 走行距離input発見:', selector);
          break;
        }
      }
      
      if (mileageInput && searchData.mileageNum) {
        mileageInput.value = searchData.mileageNum;
        mileageInput.dispatchEvent(new Event('input', { bubbles: true }));
        console.log('✅ 走行距離設定完了:', searchData.mileageNum);
      }
      
      return {
        makerSet: !!makerSelect,
        modelSet: !!modelSelect,
        budgetSet: !!budgetInput,
        mileageSet: !!mileageInput
      };
      
    }, {
      maker: maker,
      model: model,
      budget: budget,
      mileage: mileage,
      budgetNum: toNumberYen(budget),
      mileageNum: toNumberKm(mileage)
    });
    
    // 少し待機してフォームの変更を反映
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 5) 検索ボタンを動的に検出してクリック
    console.log('🚀 検索ボタンを探して実行中...');
    
    const searchResult = await page.evaluate(() => {
      // 検索ボタンを複数パターンで検索
      const buttonSelectors = [
        'button[name*="search"]',
        'input[type="submit"][value*="検索"]', 
        'button:contains("検索")',
        'input[name*="search"]',
        'button[id*="search"]',
        '.search-btn',
        '.btn-search',
        'form button[type="submit"]',
        'form input[type="submit"]'
      ];
      
      let searchButton = null;
      let usedSelector = '';
      
      // 各セレクタを順番に試す
      for (const selector of buttonSelectors) {
        try {
          if (selector.includes(':contains')) {
            // テキスト内容で検索
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
            searchButton = buttons.find(btn => 
              (btn.textContent && btn.textContent.includes('検索')) ||
              (btn.value && btn.value.includes('検索'))
            );
            if (searchButton) {
              usedSelector = 'text-based search';
              break;
            }
          } else {
            searchButton = document.querySelector(selector);
            if (searchButton) {
              usedSelector = selector;
              break;
            }
          }
        } catch (e) {
          console.log('セレクタエラー:', selector, e.message);
        }
      }
      
      if (searchButton) {
        console.log('✅ 検索ボタン発見:', usedSelector);
        searchButton.click();
        return { success: true, selector: usedSelector };
      } else {
        console.log('❌ 検索ボタンが見つかりません');
        return { success: false };
      }
    });
    
    if (!searchResult.success) {
      console.log('⚠️ 検索ボタンが見つからないため、Enterキーで送信を試行');
      await page.keyboard.press('Enter');
    }
    
    console.log('⏳ ページ遷移を待機中...');
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      console.log('✅ 検索結果ページに遷移');
    } catch (navError) {
      console.log('⚠️ ナビゲーション待機がタイムアウト、現在のページで継続');
    }

  // 6) 検索結果の存在確認とスクレイピング
    console.log('📝 検索結果を確認中...');
    
    // ページがロードされるまで少し待機
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 現在のURL確認
    const resultUrl = page.url();
    console.log('🌐 検索結果URL:', resultUrl);
    
    // 検索結果ページの構造を調査
    const pageAnalysis = await page.evaluate(() => {
      return {
        title: document.title,
        hasResults: document.querySelectorAll('div, li, tr').length > 0,
        possibleResultSelectors: [
          '.result-item',
          '.search-result',
          '.list-item', 
          '.vehicle-item',
          '.car-item',
          'tr',
          'li',
          '.item'
        ].map(sel => ({
          selector: sel,
          count: document.querySelectorAll(sel).length
        })).filter(item => item.count > 0),
        sampleHTML: document.body.innerHTML.substring(0, 1500)
      };
    });
    
    console.log('📊 検索結果ページ分析:');
    console.log('- タイトル:', pageAnalysis.title);
    console.log('- 可能な結果セレクタ:', JSON.stringify(pageAnalysis.possibleResultSelectors, null, 2));
    console.log('- サンプルHTML:', pageAnalysis.sampleHTML);
    
    // 7) 柔軟なスクレイピング（複数のセレクタパターンを試行）
    console.log('🎯 データをスクレイピング中...');
    const items = await page.evaluate(() => {
      // 結果要素を見つけるための複数のセレクタを試行
      const possibleSelectors = [
        '.result-item',
        '.search-result li', 
        '.vehicle-list li',
        '.car-list li',
        '.list-item',
        '.item',
        'tbody tr',
        '.vehicle-item',
        '.car-item'
      ];
      
      let cards = [];
      let usedSelector = '';
      
      for (const selector of possibleSelectors) {
        const elements = Array.from(document.querySelectorAll(selector));
        if (elements.length > 0) {
          cards = elements;
          usedSelector = selector;
          console.log(`✅ 結果要素発見: ${selector} (${elements.length}件)`);
          break;
        }
      }
      
      if (cards.length === 0) {
        console.log('❌ 検索結果要素が見つかりません');
        return [];
      }

      console.log('🎯 発見したカード数:', cards.length, 'セレクタ:', usedSelector);
      
      return cards.slice(0, 10).map((card, index) => {
        console.log(`📋 カード${index + 1}を処理中...`);
        
        // テキスト取得関数（複数セレクタを試行）
        const pick = (selectors) => {
          for (const s of selectors) {
            const el = card.querySelector(s);
            if (el && el.textContent) return el.textContent.trim();
          }
          // セレクタが見つからない場合は、カード全体のテキストから推測
          return '';
        };
        
        // 属性取得関数
        const pickAttr = (selectors, attr) => {
          for (const s of selectors) {
            const el = card.querySelector(s);
            if (el && el.getAttribute(attr)) return el.getAttribute(attr);
          }
          return '';
        };

        // 各データを柔軟に抽出
        const title = pick([
          '.item-title', '.title', '.name', '.vehicle-name', '.car-name',
          'h1', 'h2', 'h3', 'h4', 'h5', 'strong', '.heading'
        ]) || `車両 ${index + 1}`;
        
        const price = pick([
          '.item-price', '.price', '.cost', '.amount', '.yen',
          '*[class*="price"]', '*[class*="yen"]'
        ]) || '価格情報なし';
        
        const km = pick([
          '.item-km', '.mileage', '.distance', '.km',
          '*[class*="mileage"]', '*[class*="km"]'
        ]) || '走行距離情報なし';
        
        const imageUrl = pickAttr([
          'img', '.thumb img', '.image img', '.photo img'
        ], 'src');
        
        const url = pickAttr([
          'a[href*="detail"]', 'a[href*="vehicle"]', 'a.details', 'a.more', 'a'
        ], 'href');

        return { title, price, km, imageUrl, url };
      });
    });

    console.log('📊 スクレイピング結果:', items.length, '件');
    items.forEach((item, index) => {
      console.log(`${index + 1}: ${item.title} - ${item.price}`);
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
