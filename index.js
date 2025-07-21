const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');

// 環境変数
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
};

const client = new Client(config);
const app = express();

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
  // signature middleware に rawBody を渡す
  (req, res, next) => middleware({ 
    channelSecret: config.channelSecret, 
    payload: req.rawBody 
  })(req, res, next),
  async (req, res) => {
    // この時点で req.body はパース済み
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  }
);

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const uid   = event.source.userId;
  const text  = event.message.text.trim();
  const token = event.replyToken;

  // 初回質問
  if (!sessions.has(uid)) {
    sessions.set(uid, { step: 0, data: {} });
    return client.replyMessage(token, { type:'text', text: QUESTIONS.maker });
  }

  // 回答保存＆次へ
  const session = sessions.get(uid);
  const field   = FIELDS[session.step];
  session.data[field] = text;
  session.step++;

  if (session.step < FIELDS.length) {
    const next = FIELDS[session.step];
    return client.replyMessage(token, { type:'text', text: QUESTIONS[next] });
  }
// 全項目そろったらまず終了メッセージを投げる
await client.replyMessage(token, {
  type: 'text',
  text: '✅ 条件が揃いました。検索結果を取得中…少々お待ちください！'
});

// ダミー検索結果の返信
const { maker, model, budget, mileage } = session.data;
const resultText =
  `🔍 検索条件\n` +
  `メーカー: ${maker}\n` +
  `車名:     ${model}\n` +
  `予算:     ${budget}\n` +
  `走行距離: ${mileage}\n\n` +
  `----\n` +
  `【ダミー結果】\n` +
  `${maker} ${model}\n` +
  `価格: ${budget}円以下\n` +
  `走行: ${mileage}km以下\n` +
  `詳細: https://iauc-example.com/item/123`;

await client.replyMessage(token, { type: 'text', text: resultText });

// 会話セッションをクリア
sessions.delete(uid);
}

// エラー時も 200 応答
app.use((err, req, res, next) => {
  console.error(err);
  res.sendStatus(200);
});

// 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡️ Server running on port ${PORT}`));
