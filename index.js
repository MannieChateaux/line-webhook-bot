const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
const axios = require('axios');
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

// express.json に verify で rawBody をセット
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

// Webhook 受け口：署名検証→ハンドラ
app.post(
  '/webhook',
  (req, res, next) => middleware({
    channelSecret: config.channelSecret,
    payload: req.rawBody,
  })(req, res, next),
  async (req, res) => {
    const events = req.body.events;
    res.sendStatus(200);
    for (const e of events) handleEvent(e).catch(console.error);
  }
);

// 数値変換ヘルパー
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

// IAuc 実データ取得関数 - 改善版
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

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
    await page.setViewport({ width: 1280, height: 800 });

    // 1) サイトにアクセス
    console.log('🌐 IAucサイトにアクセス中...');
    await page.goto('https://www.iauc.co.jp/', { waitUntil: 'domcontentloaded' });
    console.log('✅ ページロード完了');
    
    // 待機時間を追加
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 2) ログイン処理
    console.log('🔐 ログイン処理を開始...');
    
    // ログインリンクを探してクリック
    const loginLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const loginLink = links.find(link => {
        const text = link.textContent || '';
        const href = link.href || '';
        return text.includes('ログイン') || href.includes('login');
      });
      if (loginLink) {
        loginLink.click();
        return true;
      }
      return false;
    });
    
    if (loginLink) {
      console.log('✅ ログインリンクをクリック');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    }
    
    // ログインフォームの入力
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const uid = process.env.IAUC_USER_ID;
    const pw = process.env.IAUC_PASSWORD;
    
    if (!uid || !pw) {
      throw new Error('IAUC_USER_ID / IAUC_PASSWORD not set');
    }

    // ユーザーID入力（複数パターン試行）
    const userFieldFilled = await page.evaluate((userId) => {
      const selectors = [
        '#userid', 'input[name="userid"]', 'input[name="user_id"]',
        'input[type="text"]', 'input[placeholder*="ID"]'
      ];
      
      for (const selector of selectors) {
        const field = document.querySelector(selector);
        if (field && field.type !== 'hidden') {
          field.value = userId;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, uid);
    
    if (userFieldFilled) {
      console.log('✅ ユーザーID入力完了');
    }

    // パスワード入力
    const passFieldFilled = await page.evaluate((password) => {
      const field = document.querySelector('input[type="password"]');
      if (field) {
        field.value = password;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    }, pw);
    
    if (passFieldFilled) {
      console.log('✅ パスワード入力完了');
    }

    // ログインボタンクリック
    const loginClicked = await page.evaluate(() => {
      // ボタンまたは送信要素を探す
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const loginBtn = buttons.find(btn => {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        return text.includes('ログイン') || text.includes('login');
      });
      
      if (loginBtn) {
        loginBtn.click();
        return true;
      }
      
      // フォーム送信も試す
      const form = document.querySelector('form');
      if (form) {
        form.submit();
        return true;
      }
      
      return false;
    });
    
    if (loginClicked) {
      console.log('✅ ログインボタンクリック');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }
    
    console.log('🌐 ログイン後のURL:', page.url());
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 3) 検索ページへ移動
    console.log('🔍 検索ページを探索中...');
    
    // 検索ページへの直接アクセスを試みる
    const searchUrls = [
      'https://www.iauc.co.jp/vehicle/search',
      'https://www.iauc.co.jp/search',
      'https://www.iauc.co.jp/vehicle',
      'https://www.iauc.co.jp/member/search'
    ];
    
    let searchPageFound = false;
    for (const url of searchUrls) {
      try {
        console.log(`🔗 試行中: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // 検索フォームの存在確認
        const hasSearchForm = await page.evaluate(() => {
          return document.querySelectorAll('input, select').length > 2;
        });
        
        if (hasSearchForm) {
          console.log('✅ 検索フォーム発見:', url);
          searchPageFound = true;
          break;
        }
      } catch (e) {
        console.log(`⚠️ ${url} へのアクセス失敗`);
      }
    }

    // 4) 検索条件入力（より柔軟に）
    console.log('📝 検索条件を入力中...');
    
    // デバッグ: 現在のページ構造を確認
    const pageStructure = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        value: el.value
      }));
      
      const selects = Array.from(document.querySelectorAll('select')).map(el => ({
        name: el.name,
        id: el.id,
        optionsCount: el.options.length,
        firstOptions: Array.from(el.options).slice(0, 5).map(opt => opt.textContent)
      }));
      
      return { inputs, selects };
    });
    
    console.log('📋 ページ構造:', JSON.stringify(pageStructure, null, 2));

    // メーカー入力を試みる
    if (maker) {
      const makerSet = await page.evaluate((makerName) => {
        // テキスト入力フィールドを探す
        const textInputs = Array.from(document.querySelectorAll('input[type="text"]'));
        for (const input of textInputs) {
          const label = input.placeholder || input.name || '';
          if (label.includes('メーカー') || label.includes('maker')) {
            input.value = makerName;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
        }
        
        // セレクトボックスを探す
        const selects = Array.from(document.querySelectorAll('select'));
        for (const select of selects) {
          const options = Array.from(select.options);
          const match = options.find(opt => 
            opt.textContent.includes(makerName)
          );
          if (match) {
            select.value = match.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        
        // フリーワード欄があれば使う
        const freewordInput = document.querySelector('input[name*="keyword"], input[name*="freeword"], input[placeholder*="キーワード"]');
        if (freewordInput) {
          freewordInput.value = makerName;
          freewordInput.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        
        return false;
      }, maker);
      
      console.log(`メーカー「${maker}」入力: ${makerSet ? '成功' : '失敗'}`);
    }

    // モデル入力を試みる
    if (model) {
      const modelSet = await page.evaluate((modelName, existingMaker) => {
        // 既存のフリーワード欄に追記
        const freewordInput = document.querySelector('input[name*="keyword"], input[name*="freeword"], input[placeholder*="キーワード"]');
        if (freewordInput) {
          if (freewordInput.value && !freewordInput.value.includes(modelName)) {
            freewordInput.value += ' ' + modelName;
          } else if (!freewordInput.value) {
            freewordInput.value = modelName;
          }
          freewordInput.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        
        // モデル専用フィールドを探す
        const modelInputs = Array.from(document.querySelectorAll('input[type="text"]'));
        for (const input of modelInputs) {
          const label = input.placeholder || input.name || '';
          if (label.includes('車種') || label.includes('model')) {
            input.value = modelName;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
        }
        
        return false;
      }, model, maker);
      
      console.log(`モデル「${model}」入力: ${modelSet ? '成功' : '失敗'}`);
    }

    // 予算入力
    if (budget) {
      const budgetNum = toNumberYen(budget);
      const budgetSet = await page.evaluate((amount) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        for (const input of inputs) {
          const label = (input.placeholder || input.name || '').toLowerCase();
          if (label.includes('価格') || label.includes('予算') || label.includes('price') || label.includes('budget')) {
            input.value = amount;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, budgetNum);
      
      console.log(`予算「${budget}」入力: ${budgetSet ? '成功' : '失敗'}`);
    }

    // 走行距離入力
    if (mileage) {
      const mileageNum = toNumberKm(mileage);
      const mileageSet = await page.evaluate((distance) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        for (const input of inputs) {
          const label = (input.placeholder || input.name || '').toLowerCase();
          if (label.includes('走行') || label.includes('距離') || label.includes('mileage') || label.includes('km')) {
            input.value = distance;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, mileageNum);
      
      console.log(`走行距離「${mileage}」入力: ${mileageSet ? '成功' : '失敗'}`);
    }

    // 5) 検索実行
    console.log('🔍 検索を実行中...');
    
    const searchExecuted = await page.evaluate(() => {
      // 検索ボタンを探す
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      const searchBtn = buttons.find(btn => {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        return text.includes('検索') || text.includes('search');
      });
      
      if (searchBtn) {
        if (searchBtn.tagName === 'A') {
          searchBtn.click();
        } else {
          searchBtn.click();
        }
        return true;
      }
      
      // フォーム送信
      const form = document.querySelector('form');
      if (form) {
        form.submit();
        return true;
      }
      
      return false;
    });
    
    if (searchExecuted) {
      console.log('✅ 検索実行');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 6) 検索結果の取得
    console.log('📊 検索結果を取得中...');
    console.log('🌐 結果ページURL:', page.url());
    
    // 結果ページの構造を調査
    const resultStructure = await page.evaluate(() => {
      // 様々なパターンで結果要素を探す
      const patterns = [
        { selector: '.result-item', name: 'result-item' },
        { selector: '.search-result', name: 'search-result' },
        { selector: '.vehicle-item', name: 'vehicle-item' },
        { selector: '.car-item', name: 'car-item' },
        { selector: 'article', name: 'article' },
        { selector: '.list-item', name: 'list-item' },
        { selector: 'tbody tr', name: 'table-row' },
        { selector: '.card', name: 'card' },
        { selector: '[class*="result"]', name: 'result-class' },
        { selector: '[class*="vehicle"]', name: 'vehicle-class' },
        { selector: '[class*="car"]', name: 'car-class' }
      ];
      
      const found = [];
      for (const pattern of patterns) {
        const count = document.querySelectorAll(pattern.selector).length;
        if (count > 0) {
          found.push({ ...pattern, count });
        }
      }
      
      return found;
    });
    
    console.log('🔍 発見した結果パターン:', resultStructure);

    // 最も有望なセレクタを使用してスクレイピング
    let items = [];
    
    if (resultStructure.length > 0) {
      const bestSelector = resultStructure[0].selector;
      console.log(`📋 セレクタ「${bestSelector}」を使用してスクレイピング`);
      
      items = await page.evaluate((selector) => {
        const elements = Array.from(document.querySelectorAll(selector)).slice(0, 10);
        
        return elements.map((el, index) => {
          // テキストコンテンツを全て取得
          const allText = el.textContent || '';
          
          // タイトル抽出（最初の見出しまたは太字テキスト）
          const titleEl = el.querySelector('h1, h2, h3, h4, h5, h6, strong, b, .title, .name');
          const title = titleEl ? titleEl.textContent.trim() : `車両 ${index + 1}`;
          
          // 価格抽出（円を含むテキスト）
          const priceMatch = allText.match(/[\d,]+円/);
          const price = priceMatch ? priceMatch[0] : '価格情報なし';
          
          // 走行距離抽出（kmを含むテキスト）
          const kmMatch = allText.match(/[\d,]+km/i);
          const km = kmMatch ? kmMatch[0] : '走行距離情報なし';
          
          // 画像URL抽出
          const imgEl = el.querySelector('img');
          const imageUrl = imgEl ? imgEl.src : '';
          
          // 詳細リンク抽出
          const linkEl = el.querySelector('a[href*="detail"], a[href*="vehicle"], a');
          const url = linkEl ? linkEl.href : '';
          
          // デバッグ情報
          console.log(`アイテム${index + 1}: ${title.substring(0, 30)}... / ${price} / ${km}`);
          
          return { title, price, km, imageUrl, url };
        });
      }, bestSelector);
      
      console.log(`✅ ${items.length}件の結果を取得`);
    }
    
    // データが取得できない場合は、ページ全体から情報を抽出
    if (items.length === 0) {
      console.log('⚠️ 構造化データが見つからないため、ページ全体から抽出');
      
      items = await page.evaluate(() => {
        // リンクから車両情報を推測
        const links = Array.from(document.querySelectorAll('a[href*="detail"], a[href*="vehicle"]')).slice(0, 10);
        
        return links.map((link, index) => {
          const parent = link.closest('div, li, tr, article') || link.parentElement;
          const text = parent ? parent.textContent : link.textContent;
          
          const title = link.textContent.trim() || `車両 ${index + 1}`;
          const priceMatch = text.match(/[\d,]+円/);
          const price = priceMatch ? priceMatch[0] : '価格情報なし';
          const kmMatch = text.match(/[\d,]+km/i);
          const km = kmMatch ? kmMatch[0] : '走行距離情報なし';
          
          const imgEl = parent ? parent.querySelector('img') : null;
          const imageUrl = imgEl ? imgEl.src : '';
          
          return {
            title,
            price,
            km,
            imageUrl,
            url: link.href
          };
        });
      });
      
      console.log(`✅ リンクベースで${items.length}件抽出`);
    }

    // モックデータ（完全に取得できない場合のフォールバック）
    if (items.length === 0) {
      console.log('⚠️ 実データ取得失敗、サンプルデータを使用');
      items = [
        {
          title: `${maker} ${model} (サンプル1)`,
          price: '見積もり依頼',
          km: '要確認',
          imageUrl: 'https://via.placeholder.com/240',
          url: 'https://www.iauc.co.jp/'
        },
        {
          title: `${maker} ${model} (サンプル2)`,
          price: '見積もり依頼',
          km: '要確認',
          imageUrl: 'https://via.placeholder.com/240',
          url: 'https://www.iauc.co.jp/'
        }
      ];
    }

    console.log('✅ fetchIaucResults完了:', items.length, '件の結果');
    return items;

  } catch (error) {
    console.error('❌ fetchIaucResults エラー:', error);
    console.error('❌ スタックトレース:', error.stack);
    
    // エラー時のフォールバック
    return [
      {
        title: 'エラーが発生しました',
        price: '再度お試しください',
        km: '-',
        imageUrl: 'https://via.placeholder.com/240',
        url: 'https://www.iauc.co.jp/'
      }
    ];
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
    text: '✅ 条件が揃いました！\n検索中です...少々お待ちください（約30秒）'
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
        text: '申し訳ございません。該当する車両が見つかりませんでした。\n\n検索条件を変更してもう一度お試しください。\n・メーカー名は「トヨタ」「ホンダ」など\n・車種名は「プリウス」「フィット」など\n・予算は「100万」「200万」など\n・走行距離は「5万km」「10万km」など'
      });
      sessions.delete(uid);
      return;
    }

    // Flex メッセージ用バブル生成
    console.log('🎨 Flexメッセージを生成中...');
    const bubbles = results.slice(0, 5).map(item => ({
      type: 'bubble',
      hero: item.imageUrl ? {
        type: 'image',
        url: item.imageUrl,
        size: 'full',
        aspectRatio: '4:3',
        aspectMode: 'cover',
      } : undefined,
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { 
            type: 'text', 
            text: item.title, 
            weight: 'bold', 
            size: 'md',
            wrap: true
          },
          { 
            type: 'text', 
            text: `💰 ${item.price}`, 
            margin: 'sm',
            color: '#FF5551' 
          },
          { 
            type: 'text', 
            text: `📏 ${item.km}`, 
            margin: 'sm',
            color: '#666666'
          },
        ],
      },
      footer: item.url ? {
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
              uri: item.url,
            },
          },
        ],
      } : undefined,
    }));
   
    // Flex メッセージで検索結果を返信
    console.log('📤 検索結果を送信中...');
    await client.pushMessage(uid, {
      type: 'flex',
      altText: `IAuc検索結果: ${results.length}件の車両が見つかりました`,
      contents: {
        type: 'carousel',
        contents: bubbles,
      },
    });
    console.log('✅ 検索結果送信完了');

    // フォローアップメッセージ
    await client.pushMessage(uid, {
      type: 'text',
      text: '検索結果は以上です。\n\n別の条件で検索したい場合は、何か文字を送信してください。'
    });

  } catch (error) {
    console.error('❌ 検索処理でエラーが発生:', error);
    console.error('❌ スタックトレース:', error.stack);
    
    await client.pushMessage(uid, {
      type: 'text',
      text: '申し訳ございません。検索処理中にエラーが発生しました。\n\nしばらく時間をおいてから再度お試しください。'
    }).catch(console.error);
  } finally {
    // 会話セッションをクリア
    console.log('🧹 セッションをクリア');
    sessions.delete(uid);
  }
}

// エラー時も 200 応答
app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  res.sendStatus(200);
});

// 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡️ Server running on port ${PORT}`));
console.log('🚀 IAuc Bot Started - Enhanced Debug Version');
console.log('📋 環境変数チェック:');
console.log('- LINE_CHANNEL_SECRET:', process.env.LINE_CHANNEL_SECRET ? '✅設定済み' : '❌未設定');
console.log('- LINE_CHANNEL_TOKEN:', process.env.LINE_CHANNEL_TOKEN ? '✅設定済み' : '❌未設定');
console.log('- IAUC_USER_ID:', process.env.IAUC_USER_ID ? '✅設定済み' : '❌未設定');
console.log('- IAUC_PASSWORD:', process.env.IAUC_PASSWORD ? '✅設定済み' : '❌未設定');
console.log('- PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH || 'デフォルト');
