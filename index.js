const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');

// 環境変数から読み込み
const config = {
  channelSecret:  process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
};

const client = new Client(config);
const app = express();

// ユーザーごとの会話ステートを簡易保持
const sessions = new Map();

// 会話ステート設計
const FIELDS = ['maker', 'model', 'budget', 'mileage'];
const QUESTIONS = {
  maker:   '🚗 まず「メーカー」を教えてください（例：トヨタ、スバル）',
  model:   '🚗 次に「車名」を教えてください（例：ヤリス、サンバー）',
  budget:  '💰 ご予算はいくらですか？（例：50万、200万）',
  mileage: '📏 走行距離の上限を教えてください（例：1万km、5万km）',
};

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  middleware(config),
  async (req, res) => {
    const events = JSON.parse(req.body.toString('utf8')).events;
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  }
);

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text   = event.message.text.trim();
  const reply  = event.replyToken;

  // 初回はメーカーから
  if (!sessions.has(userId)) {
    sessions.set(userId, { step: 0, data: {} });
    return client.replyMessage(reply, { type: 'text', text: QUESTIONS.maker });
  }

  const session = sessions.get(userId);
  const field   = FIELDS[session.step];
  session.data[field] = text;
  session.step++;

  if (session.step < FIELDS.length) {
    const nextField = FIELDS[session.step];
    return client.replyMessage(reply, {
      type: 'text',
      text: QUESTIONS[nextField],
    });
  }

  // 必須４項目揃ったらダミー結果を返す
  const { maker, model, budget, mileage } = session.data;
  const dummyResults = [{
    title: `${maker} ${model}`,
    price: `${budget}円以下`,
    km:    `${mileage}km以下`,
    url:   'https://iauc-example.com/item/123',
  }];

  await client.replyMessage(reply, {
    type: 'text',
    text:
      `🔍 検索条件:\n` +
      `メーカー: ${maker}\n` +
      `車名:     ${model}\n` +
      `予算:     ${budget}\n` +
      `走行距離: ${mileage}\n\n` +
      `----\n` +
      `【ダミー結果】\n` +
      `${dummyResults[0].title}\n` +
      `価格:${dummyResults[0].price}\n` +
      `走行:${dummyResults[0].km}\n` +
      `詳細: ${dummyResults[0].url}`
  );

  sessions.delete(userId);
}

app.use((err, req, res, next) => {
  console.error(err);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡️ Server running on port ${PORT}`));
