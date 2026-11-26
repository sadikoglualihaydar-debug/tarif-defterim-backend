FROM node:22-slim

# Install ffmpeg, python3, curl, and Tesseract OCR (Turkish + English) + latest yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    tesseract-ocr \
    tesseract-ocr-tur \
    tesseract-ocr-eng \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY *.mjs ./

RUN mkdir -p /app/data /app/.tmp

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.mjs"]
