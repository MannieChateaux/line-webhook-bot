# Puppeteer/Chromium が最初から入っている公式イメージ
FROM ghcr.io/puppeteer/puppeteer:22.10.0

WORKDIR /app
# 先に設定：npm install 時の Chromium 再DLを止める
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production


# 依存をクリーンに入れる
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# アプリ本体
COPY . .

# Puppeteer に使わせる Chromium のパスを固定
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Render が割り当てる PORT を使う想定（index.js で process.env.PORT を参照）
EXPOSE 10000

# 起動コマンド
CMD ["node", "index.js"]
