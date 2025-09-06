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
    return String(parseInt(match[1], 10) * 10000);
  }
  const numMatch = cleaned.match(/\d+/);
  return numMatch ? numMatch[0] : '';
}

function toNumberKm(text) {
  if (!text) return '';
  const cleaned = text.replace(/[^\d万千km]/g, '');
  
  // 「3万km」形式
  const manMatch = cleaned.match(/(\d+)万/);
  if (manMatch) {
    return String(parseInt(manMatch[1], 10) * 10000);
  }
  
  // 「30千km」形式（IAucの特殊表記）
  const senMatch = cleaned.match(/(\d+)千/);
  if (senMatch) {
    return String(parseInt(senMatch[1], 10) * 1000);
  }
  
  // 純粋な数値
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
    console.log('🔐 ログイン処理...');
    
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

    // 3) 検索ページへ移動
    console.log('🔍 検索ページへ移動...');
    
    // 検索ページURLを試行
    const searchUrls = [
      'https://www.iauc.co.jp/vehicle/search',
      'https://www.iauc.co.jp/search',
      'https://www.iauc.co.jp/inquiry/confirm.php'  // PDFで見た実際のURL
    ];
    
    for (const url of searchUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const hasForm = await page.evaluate(() => {
          return document.querySelectorAll('input, select').length > 0;
        });
        
        if (hasForm) {
          console.log('✅ 検索フォーム発見:', url);
          break;
        }
      } catch (e) {
        console.log(`⚠️ ${url} 試行失敗`);
      }
    }

    // 4) フリーワード検索フィールドに入力
    console.log('📝 検索条件入力...');
    
    // フリーワード検索用のキーワードを構築
    const keywords = [];
    if (maker && maker !== 'パス') keywords.push(maker);
    if (model && model !== 'パス') keywords.push(model);
    if (grade && grade !== 'パス') keywords.push(grade);
    if (type && type !== 'パス') keywords.push(type);
    
    const searchKeyword = keywords.join(' ');
    console.log('🔍 検索キーワード:', searchKeyword);

    if (searchKeyword) {
      // フリーワード入力欄を探して入力
      const keywordEntered = await page.evaluate((keyword) => {
        // 複数のパターンで検索欄を探す
        const selectors = [
          'input[name*="keyword"]',
          'input[name*="freeword"]',
          'input[placeholder*="キーワード"]',
          'input[placeholder*="フリーワード"]',
          'input[type="text"]'  // 最後の手段
        ];
        
        for (const selector of selectors) {
          const input = document.querySelector(selector);
          if (input) {
            input.value = keyword;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            console.log('✅ キーワード入力:', selector);
            return true;
          }
        }
        return false;
      }, searchKeyword);
      
      if (!keywordEntered) {
        console.log('⚠️ フリーワード入力欄が見つかりません');
      }
    }

    // 5) 検索実行
    console.log('🔍 検索実行...');
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      const searchBtn = buttons.find(btn => {
        const text = (btn.textContent || btn.value || '').toLowerCase();
        return text.includes('検索') || text.includes('search');
      });
      
      if (searchBtn) {
        searchBtn.click();
      } else {
        const form = document.querySelector('form');
        if (form) form.submit();
      }
    });

    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 6) 予算・走行距離でフィルタ（絞り込み画面がある場合）
    console.log('🎯 絞り込み条件適用...');
    
    // 予算フィルタ
    if (budget) {
      const budgetNum = toNumberYen(budget);
      await page.evaluate((amount) => {
        // 予算入力欄を探す
        const inputs = Array.from(document.querySelectorAll('input'));
        for (const input of inputs) {
          const label = (input.placeholder || input.name || '').toLowerCase();
          if (label.includes('予算') || label.includes('価格') || label.includes('price')) {
            input.value = amount;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            break;
          }
        }
      }, budgetNum);
    }

    // 走行距離フィルタ
    if (mileage) {
      const mileageNum = toNumberKm(mileage);
      
      // チェックボックス形式の場合（PDFの画像参照）
      const checkboxSelected = await page.evaluate((distance) => {
        // 走行距離のチェックボックスを探す
        const labels = Array.from(document.querySelectorAll('label'));
        for (const label of labels) {
          const text = label.textContent || '';
          if (text.includes('km') && text.includes(String(distance / 10000) + '万')) {
            const checkbox = label.querySelector('input[type="checkbox"]');
            if (checkbox) {
              checkbox.checked = true;
              checkbox.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
        }
        return false;
      }, mileageNum);
      
      if (!checkboxSelected) {
        // 入力欄形式の場合
        await page.evaluate((distance) => {
          const inputs = Array.from(document.querySelectorAll('input'));
          for (const input of inputs) {
            const label = (input.placeholder || input.name || '').toLowerCase();
            if (label.includes('走行') || label.includes('距離') || label.includes('mileage')) {
              input.value = distance;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              break;
            }
          }
        }, mileageNum);
      }
    }

    // 絞り込み実行（OKボタンなど）
    await page.evaluate(() => {
      const okBtn = Array.from(document.querySelectorAll('button, input')).find(btn => {
        const text = (btn.textContent || btn.value || '');
        return text === 'OK' || text === '絞り込み' || text === '検索';
      });
      if (okBtn) okBtn.click();
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 7) 検索結果取得
    console.log('📊 検索結果を取得中...');
    
    const results = await page.evaluate(() => {
      // 様々なパターンで結果を探す
      const items = [];
      
      // テーブル形式の場合
      const rows = document.querySelectorAll('tbody tr');
      if (rows.length > 0) {
        rows.forEach((row, index) => {
          if (index === 0) return; // ヘッダー行スキップ
          
          const cells = row.querySelectorAll('td');
          if (cells.length > 0) {
            const text = row.textContent || '';
            
            // 各セルからデータ抽出
            const title = cells[0]?.textContent?.trim() || `車両 ${index}`;
            const priceMatch = text.match(/[\d,]+円/);
            const price = priceMatch ? priceMatch[0] : '要確認';
            const kmMatch = text.match(/[\d,]+千?km/i);
            const km = kmMatch ? kmMatch[0] : '要確認';
            
            const link = row.querySelector('a');
            const url = link ? link.href : '';
            
            items.push({ title, price, km, url, imageUrl: '' });
          }
        });
      }
      
      // リスト形式の場合
      if (items.length === 0) {
        const listItems = document.querySelectorAll('.result-item, .vehicle-item, .car-item, li');
        listItems.forEach((item, index) => {
          const text = item.textContent || '';
          const titleEl = item.querySelector('h2, h3, h4, .title, .name');
          const title = titleEl ? titleEl.textContent.trim() : `車両 ${index + 1}`;
          
          const priceMatch = text.match(/[\d,]+円/);
          const price = priceMatch ? priceMatch[0] : '要確認';
          const kmMatch = text.match(/[\d,]+千?km/i);
          const km = kmMatch ? kmMatch[0] : '要確認';
          
          const img = item.querySelector('img');
          const imageUrl = img ? img.src : '';
          
          const link = item.querySelector('a');
          const url = link ? link.href : '';
          
          items.push({ title, price, km, imageUrl, url });
        });
      }
      
      return items.slice(0, 10); // 最大10件
    });

    console.log(`✅ ${results.length}件の結果取得`);
    
    // URLの補正
    results.forEach(item => {
      if (item.url && !item.url.startsWith('http')) {
        item.url = 'https://www.iauc.co.jp' + item.url;
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
      // Flexメッセージ作成
      const bubbles = results.slice(0, 5).map(item => ({
        type: 'bubble',
        hero: item.imageUrl ? {
          type: 'image',
          url: item.imageUrl || 'https://via.placeholder.com/240',
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
            }
          ]
        },
        footer: item.url ? {
          type: 'box',
          layout: 'vertical',
          contents: [{
            type: 'button',
            style: 'primary',
            action: {
              type: 'uri',
              label: '詳細を見る',
              uri: item.url
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
  console.log('🚀 IAuc Bot Started - Improved Version');
  console.log('📋 環境変数チェック:');
  console.log('- LINE_CHANNEL_SECRET:', process.env.LINE_CHANNEL_SECRET ? '✅' : '❌');
  console.log('- LINE_CHANNEL_TOKEN:', process.env.LINE_CHANNEL_TOKEN ? '✅' : '❌');
  console.log('- IAUC_USER_ID:', process.env.IAUC_USER_ID ? '✅' : '❌');
  console.log('- IAUC_PASSWORD:', process.env.IAUC_PASSWORD ? '✅' : '❌');
  console.log('- PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH || 'default');
});
