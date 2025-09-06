const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
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
const FIELDS = ['maker','model','grade','type','budget','mileage'];
const QUESTIONS = {
  maker:   '🚗 メーカーを教えてください\n（例：スバル、アルファロメオ、ランチア）\n\n❗わからない場合は「パス」と入力\n🔄 最初からやり直す場合は「戻る」と入力',
  model:   '🚗 車名を教えてください\n（例：インプレッサ、155、デルタ）\n\n❗わからない場合は「パス」と入力\n🔄 最初からやり直す場合は「戻る」と入力',
  grade:   '⭐ グレードを教えてください\n（例：WRX、V6 TI、インテグラーレエヴォルツィオーネ）\n\n❗わからない場合は「パス」と入力\n🔄 最初からやり直す場合は「戻る」と入力',
  type:    '📋 型式を教えてください\n（例：GC8、167A1E、L31E5）\n\n❗わからない場合は「パス」と入力\n🔄 最初からやり直す場合は「戻る」と入力',
  budget:  '💰 予算上限を教えてください\n（例：100万円、500万円）\n\n🔄 最初からやり直す場合は「戻る」と入力',
  mileage: '📏 走行距離上限を教えてください\n（例：3万km、10万km）\n\n🔄 最初からやり直す場合は「戻る」と入力',
};

// Webhook 受け口
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
  const cleaned = text.replace(/[^\d万円]/g, '');
  const match = cleaned.match(/(\d+)万/);
  if (match) {
    return String(parseInt(match[1], 10));
  }
  const numMatch = cleaned.match(/\d+/);
  if (numMatch && numMatch[0].length >= 6) {
    return String(Math.floor(parseInt(numMatch[0]) / 10000));
  }
  return numMatch ? numMatch[0] : '';
}

function toNumberKm(text) {
  if (!text) return '';
  const cleaned = text.replace(/[^\d万千km]/g, '');
  
  const manMatch = cleaned.match(/(\d+)万/);
  if (manMatch) {
    return String(parseInt(manMatch[1], 10) * 10000);
  }
  
  const senMatch = cleaned.match(/(\d+)千/);
  if (senMatch) {
    return String(parseInt(senMatch[1], 10) * 1000);
  }
  
  const numMatch = cleaned.match(/\d+/);
  return numMatch ? numMatch[0] : '';
}

// IAuc検索関数
async function searchIauc({ maker, model, grade, type, budget, mileage }) {
  console.log('🔍 IAuc検索開始:', { maker, model, grade, type, budget, mileage });
  
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
  let browser;
  let page;
  
  try {
    console.log('🚀 ブラウザ起動中...');
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

    // 1) IAucサイトアクセス
    console.log('🌐 IAucにアクセス中...');
    await page.goto('https://www.iauc.co.jp/', { waitUntil: 'domcontentloaded' });
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2) ログイン処理
    console.log('🔐 ログイン処理開始...');
    
    // 同時ログイン対策: Cookieクリア
    await page.evaluate(() => {
      document.cookie.split(";").forEach(cookie => {
        const eqPos = cookie.indexOf("=");
        const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
        document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
      });
      if (typeof(Storage) !== "undefined") {
        localStorage.clear();
        sessionStorage.clear();
      }
    });

    // ログインリンクを探してクリック
    const loginClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const loginLink = links.find(link => {
        const text = (link.textContent || '').toLowerCase();
        const href = (link.href || '').toLowerCase();
        return text.includes('ログイン') || text.includes('login') || href.includes('login');
      });
      if (loginLink) {
        loginLink.click();
        return true;
      }
      return false;
    });
    
    if (loginClicked) {
      console.log('✅ ログインページへ遷移');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // ログイン情報入力
    const uid = process.env.IAUC_USER_ID;
    const pw = process.env.IAUC_PASSWORD;
    
    if (!uid || !pw) {
      throw new Error('IAUC認証情報が未設定です');
    }

    // ID入力
    await page.evaluate((userId) => {
      const inputs = document.querySelectorAll('input[type="text"], input[name*="user"], input[name*="id"]');
      if (inputs.length > 0) {
        inputs[0].value = userId;
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, uid);

    // パスワード入力
    await page.evaluate((password) => {
      const pwInput = document.querySelector('input[type="password"]');
      if (pwInput) {
        pwInput.value = password;
        pwInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, pw);

    // ログイン実行
    await page.evaluate(() => {
      const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]');
      if (submitBtn) {
        submitBtn.click();
      } else {
        const form = document.querySelector('form');
        if (form) form.submit();
      }
    });

    console.log('⏳ ログイン完了待機...');
    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 同時ログイン規制チェック
    const isKickedOut = await page.evaluate(() => {
      const bodyText = document.body.textContent || '';
      return bodyText.includes('セッションが切断されました') || 
             bodyText.includes('同じIDでログインしました') ||
             bodyText.includes('logged out');
    });

    if (isKickedOut) {
      console.log('⚠️ 同時ログイン規制検出、10秒待機後再試行');
      await new Promise(resolve => setTimeout(resolve, 10000));
      throw new Error('同時ログイン規制');
    }

    // 3) 会場選択プロセス（重要：前スレで解決済みの処理）
    console.log('🎯 会場選択プロセス開始...');
    
    // 緑色全選択ボタンクリック
    await page.click('#btn_vehicle_everyday_all').catch(() => {
      console.log('⚠️ 緑色全選択ボタンが見つかりません');
    });
    console.log('✅ 緑色全選択完了');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 青色全選択ボタンクリック  
    await page.click('#btn_vehicle_day_all').catch(() => {
      console.log('⚠️ 青色全選択ボタンが見つかりません');
    });
    console.log('✅ 青色全選択完了');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 次へボタンクリック
    await page.click('button.page-next-button.col-md-2.col-xs-4').catch(() => {
      console.log('⚠️ 次へボタンが見つかりません');
    });
    console.log('✅ 次へボタンクリック完了');
    
    // ページ遷移を待機（長いパラメータ付きURLに到達）
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('🌐 現在のURL:', page.url());

    // 4) フリーワード検索タブをクリック
    console.log('🔍 フリーワード検索タブをクリック...');
    
    const freewordTabClicked = await page.evaluate(() => {
      // フリーワード検索タブを複数パターンで探す
      const tabs = Array.from(document.querySelectorAll('button, a, div'));
      for (const tab of tabs) {
        const text = (tab.textContent || '').trim();
        if (text === 'フリーワード検索' || text.includes('フリーワード')) {
          tab.click();
          console.log('✅ フリーワード検索タブクリック');
          return true;
        }
      }
      return false;
    });
    
    if (freewordTabClicked) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 5) フリーワード検索ボックスに入力
    console.log('📝 検索条件入力...');
    
    const keywords = [];
    if (maker && maker !== 'パス') keywords.push(maker);
    if (model && model !== 'パス') keywords.push(model);
    if (grade && grade !== 'パス') keywords.push(grade);
    if (type && type !== 'パス') keywords.push(type);
    
    const searchKeyword = keywords.join(' ');
    console.log('🔍 検索キーワード:', searchKeyword);

    if (searchKeyword) {
      const keywordEntered = await page.evaluate((keyword) => {
        // より広範囲でフリーワード入力欄を探す
        const selectors = [
          'input[name*="freeword"]',
          'input[placeholder*="フリーワード"]',
          'input[placeholder*="キーワード"]',
          'input[name*="keyword"]',
          'textarea[name*="freeword"]',
          'input[type="text"]'
        ];
        
        for (const selector of selectors) {
          const input = document.querySelector(selector);
          if (input && input.offsetParent !== null) { // 表示されている要素のみ
            input.value = keyword;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            console.log('✅ キーワード入力完了:', selector);
            return true;
          }
        }
        return false;
      }, searchKeyword);
      
      if (!keywordEntered) {
        console.log('⚠️ フリーワード入力欄が見つかりません');
      }
    }

    // 6) 検索実行
    console.log('🔍 検索実行...');
    const searchExecuted = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      for (const btn of buttons) {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        if (text.includes('検索') || text.includes('search')) {
          btn.click();
          console.log('✅ 検索ボタンクリック');
          return true;
        }
      }
      return false;
    });

    if (searchExecuted) {
      await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      // 次へボタンでも試行
      await page.evaluate(() => {
        const nextBtns = Array.from(document.querySelectorAll('button, input'));
        for (const btn of nextBtns) {
          const text = (btn.textContent || btn.value || '');
          if (text === '次へ') {
            btn.click();
            return;
          }
        }
      });
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // 7) 業販車フィルタ処理
    console.log('🎯 業販車フィルタ処理開始...');
    
    // 結果カラムの絞り込みボタンをクリック
    const resultButtonClicked = await page.evaluate(() => {
      // 結果カラムのボタンを探す
      const buttons = Array.from(document.querySelectorAll('a, button'));
      for (const btn of buttons) {
        const classes = btn.className || '';
        const text = btn.textContent || '';
        if (classes.includes('narrow_button') && (classes.includes('result') || text.includes('結果'))) {
          btn.click();
          console.log('✅ 結果ボタンクリック');
          return true;
        }
      }
      return false;
    });

    if (resultButtonClicked) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 業販車フィルタ選択（未せり、仮出品、申込可）
      await page.evaluate(() => {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        const labels = document.querySelectorAll('label');
        
        ['未せり', '仮出品', '申込可'].forEach(filterText => {
          // ラベルテキストで検索
          for (const label of labels) {
            if (label.textContent && label.textContent.includes(filterText)) {
              const checkbox = label.querySelector('input[type="checkbox"]') || 
                             document.querySelector(`input[type="checkbox"][value*="${filterText}"]`);
              if (checkbox) {
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                console.log(`✅ ${filterText}選択完了`);
              }
            }
          }
        });
      });
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // OKボタンクリック
      await page.evaluate(() => {
        const okButtons = Array.from(document.querySelectorAll('button, input'));
        for (const btn of okButtons) {
          const text = (btn.textContent || btn.value || '');
          if (text === 'OK' || text === 'ok') {
            btn.click();
            console.log('✅ OKボタンクリック');
            return;
          }
        }
      });
      
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // 8) 予算・走行距離フィルタ
    console.log('💰 予算フィルタ処理...');
    if (budget) {
      const budgetAmount = toNumberYen(budget);
      
      const priceFilterClicked = await page.evaluate(() => {
        // スタートカラムのボタンを探す
        const buttons = Array.from(document.querySelectorAll('a, button'));
        for (const btn of buttons) {
          const classes = btn.className || '';
          const text = btn.textContent || '';
          if (text.includes('スタート') || classes.includes('start')) {
            btn.click();
            console.log('✅ 価格フィルタボタンクリック');
            return true;
          }
        }
        return false;
      });
      
      if (priceFilterClicked) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // 価格入力
        await page.evaluate((amount) => {
          const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
          for (const input of inputs) {
            const id = input.id || '';
            const name = input.name || '';
            if (id.includes('startPrice') || name.includes('price') || id.includes('To')) {
              input.value = amount;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              console.log('✅ 価格入力完了:', amount);
              break;
            }
          }
        }, budgetAmount);
        
        // OK実行
        await page.evaluate(() => {
          const okBtn = document.querySelector('button:contains("OK"), input[value="OK"]') ||
                       Array.from(document.querySelectorAll('button')).find(btn => btn.textContent === 'OK');
          if (okBtn) okBtn.click();
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // 9) 走行距離フィルタ
    console.log('📏 走行距離フィルタ処理...');
    if (mileage) {
      const mileageNum = toNumberKm(mileage);
      
      const mileageFilterClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('a, button'));
        for (const btn of buttons) {
          const text = btn.textContent || '';
          if (text.includes('走行') || text === '走行') {
            btn.click();
            console.log('✅ 走行距離フィルタボタンクリック');
            return true;
          }
        }
        return false;
      });
      
      if (mileageFilterClicked) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // 走行距離チェックボックス選択
        await page.evaluate((maxMileage) => {
          const mileageLimit = Math.floor(maxMileage / 10000); // 万km単位
          const checkboxes = document.querySelectorAll('input[type="checkbox"]');
          const labels = document.querySelectorAll('label');
          
          // 指定上限以下の項目をすべてチェック
          for (let i = 1; i <= mileageLimit; i++) {
            for (const label of labels) {
              const text = label.textContent || '';
              if (text.includes(`${i}万km`) || text.includes(`${i}万`)) {
                const checkbox = label.querySelector('input[type="checkbox"]');
                if (checkbox) {
                  checkbox.checked = true;
                  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                  console.log(`✅ ${i}万km選択`);
                }
              }
            }
          }
        }, mileageNum);
        
        // OK実行
        await page.evaluate(() => {
          const okBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent === 'OK');
          if (okBtn) okBtn.click();
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // 10) 価格昇順ソート
    console.log('⬆️ 価格昇順ソート実行...');
    await page.evaluate(() => {
      // スタートカラムの上向き三角ボタンを探す
      const sortButtons = Array.from(document.querySelectorAll('a, button, span'));
      for (const btn of sortButtons) {
        const classes = btn.className || '';
        const title = btn.title || '';
        if (classes.includes('sort_button') && 
           (title.includes('並び替え') || classes.includes('asc'))) {
          btn.click();
          console.log('✅ 価格昇順ソート実行');
          return;
        }
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 11) 検索結果データ取得
    console.log('📊 検索結果データ取得中...');
    
    const results = await page.evaluate(() => {
      const items = [];
      
      // テーブル行を取得
      const rows = document.querySelectorAll('tbody tr, .list-item, .vehicle-item');
      
      rows.forEach((row, index) => {
        try {
          const cells = row.querySelectorAll('td, .cell, .item-data');
          
          // サムネイル画像
          const img = row.querySelector('img');
          const imageUrl = img ? img.src : '';
          
          // 車名とグレード（最初のセルまたはタイトル要素）
          const titleEl = row.querySelector('h1, h2, h3, h4, .title, .name') || cells[1];
          const title = titleEl ? titleEl.textContent.trim() : `車両 ${index + 1}`;
          
          // 価格抽出
          const rowText = row.textContent || '';
          const priceMatch = rowText.match(/(\d+(?:,\d+)*(?:\.\d+)?)万?円/);
          const price = priceMatch ? priceMatch[0] : '価格要確認';
          
          // 走行距離抽出
          const kmMatch = rowText.match(/(\d+(?:,\d+)*(?:\.\d+)?)(?:千)?km/i);
          const mileage = kmMatch ? kmMatch[0] : '走行距離要確認';
          
          // 年式抽出
          const yearMatch = rowText.match(/([HRS]?\d{1,2}年|\d{4}年)/);
          const year = yearMatch ? yearMatch[0] : '年式要確認';
          
          // 会場名・地区抽出（オークションハウス情報）
          const venueMatch = rowText.match(/(LAP|TAA|JU|オークネット|ミライブ).*?[都道府県市区町村]/);
          const venue = venueMatch ? venueMatch[0] : '会場要確認';
          const location = venue.includes('東京') ? '関東' : 
                          venue.includes('大阪') ? '関西' : 
                          venue.includes('愛知') ? '中部' : '地区要確認';
          
          // 詳細URLの取得
          const link = row.querySelector('a');
          const detailUrl = link ? link.href : '';
          
          items.push({
            imageUrl,
            title,
            mileage,
            price,
            year,
            venue,
            location,
            detailUrl
          });
          
        } catch (error) {
          console.log(`車両${index + 1}のデータ抽出エラー:`, error);
        }
      });
      
      return items.slice(0, 10); // 最大10件
    });

    console.log(`✅ ${results.length}件の検索結果を取得`);
    results.forEach((item, i) => {
      console.log(`${i + 1}: ${item.title} - ${item.price} - ${item.mileage}`);
    });
    
    // URL補正
    results.forEach(item => {
      if (item.detailUrl && !item.detailUrl.startsWith('http')) {
        item.detailUrl = 'https://www.iauc.co.jp' + item.detailUrl;
      }
      if (item.imageUrl && !item.imageUrl.startsWith('http')) {
        item.imageUrl = 'https://www.iauc.co.jp' + item.imageUrl;
      }
    });

    return results;

  } catch (error) {
    console.error('❌ 検索エラー:', error);
    return [];
  } finally {
    if (page) await page.close().catch(console.error);
    if (browser) await browser.close().catch(console.error);
  }
}

// イベントハンドラ
async function handleEvent(event) {
  console.log('📨 イベント受信:', event.type);
  
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const uid = event.source.userId;
  const text = event.message.text.trim();
  const token = event.replyToken;

  console.log('💬 受信:', text);

  // 「戻る」コマンドで最初から
  if (text === '戻る') {
    sessions.delete(uid);
    return client.replyMessage(token, {
      type: 'text',
      text: '🔄 最初からやり直します。\n\n' + QUESTIONS.maker
    });
  }

  // 初回またはリセット後
  if (!sessions.has(uid)) {
    sessions.set(uid, { step: 0, data: {} });
    return client.replyMessage(token, {
      type: 'text',
      text: '🚗 IAuc車両検索へようこそ！\n\n質問に答えて検索条件を設定してください。\n\n' + QUESTIONS.maker
    });
  }

  // セッション更新
  const session = sessions.get(uid);
  const field = FIELDS[session.step];
  
  // パスの場合は空文字として保存
  session.data[field] = (text === 'パス') ? '' : text;
  session.step++;

  console.log('📊 セッション:', session);

  // 次の質問
  if (session.step < FIELDS.length) {
    const nextField = FIELDS[session.step];
    return client.replyMessage(token, {
      type: 'text',
      text: QUESTIONS[nextField]
    });
  }

  // 全質問終了 → 検索実行
  console.log('🔍 検索条件確定:', session.data);
  
  await client.replyMessage(token, {
    type: 'text',
    text: '✅ 検索条件を受け付けました！\n\n🔍 IAucで検索中...\n（約30秒お待ちください）'
  });

  try {
    const results = await searchIauc(session.data);
    
    if (!results || results.length === 0) {
      await client.pushMessage(uid, {
        type: 'text',
        text: '😔 該当する車両が見つかりませんでした。\n\n検索条件を変更してお試しください。\n何か入力すると最初から検索できます。'
      });
    } else {
      // Flexメッセージ作成（7項目表示）
      const bubbles = results.slice(0, 5).map(item => ({
        type: 'bubble',
        hero: item.imageUrl ? {
          type: 'image',
          url: item.imageUrl || 'https://via.placeholder.com/240x180/cccccc/000000?text=No+Image',
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
              color: '#FF5551',
              size: 'sm'
            },
            {
              type: 'text',
              text: `📏 ${item.mileage}`,
              margin: 'xs',
              color: '#666666',
              size: 'sm'
            },
            {
              type: 'text',
              text: `📅 ${item.year}`,
              margin: 'xs',
              color: '#666666',
              size: 'xs'
            },
            {
              type: 'text',
              text: `🏢 ${item.venue}`,
              margin: 'xs',
              color: '#999999',
              size: 'xs'
            },
            {
              type: 'text',
              text: `📍 ${item.location}`,
              margin: 'xs',
              color: '#999999',
              size: 'xs'
            }
          ]
        },
        footer: item.detailUrl ? {
          type: 'box',
          layout: 'vertical',
          contents: [{
            type: 'button',
            style: 'primary',
            color: '#0066CC',
            action: {
              type: 'uri',
              label: '詳細を見る',
              uri: item.detailUrl
            }
          }]
        } : undefined
      }));

      await client.pushMessage(uid, {
        type: 'flex',
        altText: `🚗 ${results.length}件の車両が見つかりました`,
        contents: {
          type: 'carousel',
          contents: bubbles
        }
      });

      // 追加の車両がある場合はテキストでも表示
      if (results.length > 5) {
        let additionalText = '📋 追加の車両情報:\n\n';
        results.slice(5).forEach((item, index) => {
          additionalText += `${index + 6}. ${item.title}\n`;
          additionalText += `💰 ${item.price} 📏 ${item.mileage}\n`;
          additionalText += `📅 ${item.year} 🏢 ${item.venue}\n\n`;
        });
        
        await client.pushMessage(uid, {
          type: 'text',
          text: additionalText
        });
      }

      await client.pushMessage(uid, {
        type: 'text',
        text: `✨ ${results.length}件の車両が見つかりました！\n\n別の条件で検索する場合は、何か入力してください。`
      });
    }
  } catch (error) {
    console.error('❌ エラー:', error);
    await client.pushMessage(uid, {
      type: 'text',
      text: '⚠️ エラーが発生しました。\nしばらく待ってから再度お試しください。'
    }).catch(console.error);
  } finally {
    sessions.delete(uid);
  }
}

// エラーハンドラ
app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  res.sendStatus(200);
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡️ Server running on port ${PORT}`);
  console.log('🚀 IAuc Bot Started - Complete Fixed Version');
  console.log('📋 環境変数チェック:');
  console.log('- LINE_CHANNEL_SECRET:', process.env.LINE_CHANNEL_SECRET ? '✅' : '❌');
  console.log('- LINE_CHANNEL_TOKEN:', process.env.LINE_CHANNEL_TOKEN ? '✅' : '❌');
  console.log('- IAUC_USER_ID:', process.env.IAUC_USER_ID ? '✅' : '❌');
  console.log('- IAUC_PASSWORD:', process.env.IAUC_PASSWORD ? '✅' : '❌');
  console.log('- PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH || 'default');
});
