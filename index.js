const express = require('express');
const { middleware } = require('@line/bot-sdk');

const config = {
  channelSecret:  process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
};

const app = express();

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  middleware(config),
  (req, res) => {
    const body = JSON.parse(req.body.toString('utf8'));
    console.log(body);
    res.sendStatus(200);
  }
);

app.use((err, req, res, next) => {
  console.error(err);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT);
