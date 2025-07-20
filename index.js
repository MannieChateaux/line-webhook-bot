const express = require('express');
const { middleware } = require('@line/bot-sdk');

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_TOKEN,
};

const app = express();
app.use(express.json());
app.post('/webhook', middleware(config), (req, res) => {
  console.log(req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡️ Bot listening on port ${PORT}`);
});
