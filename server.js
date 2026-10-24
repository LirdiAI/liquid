
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_BODY = 18 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set([
  'https://lirdiai.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const pathname = new URL(req.url, 'http://localhost').pathname;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };

  if (ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }

  // Главная страница — если файл есть в проекте
  if (
    req.method === 'GET' &&
    (pathname === '/' || pathname === '/index.html')
  ) {
    const htmlPath = path.join(__dirname, 'index.html');

    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404, headers);
      return res.end(JSON.stringify({
        error: 'Файл index.html не найден. Открой сайт через GitHub Pages.'
      }));
    }

    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/html; charset=utf-8'
    });

    return fs.createReadStream(htmlPath).pipe(res);
  }

  // Проверка работоспособности сервера
  if (req.method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({
      status: 'ok',
      model: MODEL,
      apiKeyConfigured: Boolean(API_KEY)
    }));
  }

  // Gemini API
  if (req.method === 'POST' && pathname === '/api/chat') {
    if (!API_KEY) {
      res.writeHead(500, headers);
      return res.end(JSON.stringify({
        error: 'На Render не задан GEMINI_API_KEY.'
      }));
    }

    let raw = '';
    let tooLarge = false;

    req.on('data', chunk => {
      if (tooLarge) return;

      raw += chunk.toString();

      if (Buffer.byteLength(raw) > MAX_BODY) {
        tooLarge = true;
        res.writeHead(413, headers);
        res.end(JSON.stringify({
          error: 'Запрос слишком большой. Уменьши размер вложений.'
        }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (tooLarge) return;

      try {
        const body = JSON.parse(raw || '{}');

        const history = Array.isArray(body.history)
          ? body.history.slice(-24)
          : [];

        const contents = history
          .filter(item => item && typeof item.text === 'string')
          .map(item => ({
            role: item.role === 'user' ? 'user' : 'model',
            parts: [{ text: item.text.slice(0, 16000) }]
          }));

        const parts = [];
        const attachments = Array.isArray(body.attachments)
          ? body.attachments.slice(0, 8)
          : [];

        for (const file of attachments) {
          if (!file || typeof file.data !== 'string') continue;

          const name = String(file.name || 'file').slice(0, 160);
          const mime = String(
            file.mimeType || 'application/octet-stream'
          );

          // Поддержка изображений и PDF
          if (mime.startsWith('image/') || mime === 'application/pdf') {
            const base64 = file.data.replace(
              /^data:[^,]*;base64,/,
              ''
            );

            parts.push({ text: `Прикреплён файл: ${name}` });
            parts.push({
              inlineData: {
                mimeType: mime,
                data: base64
              }
            });

            continue;
          }

          // Поддержка текстовых и программных файлов
          const isText =
            /^(text\/|application\/(json|xml|javascript|x-python|x-sh|typescript))/i.test(mime) ||
            /\.(txt|md|js|jsx|ts|tsx|py|java|kt|html|css|json|xml|csv|yml|yaml|sql|sh)$/i.test(name);

          if (isText) {
            const base64 = file.data.replace(
              /^data:[^,]*;base64,/,
              ''
            );

            const decoded = Buffer.from(base64, 'base64')
              .toString('utf8');

            parts.push({
              text: `Содержимое файла «${name}»:\n${decoded.slice(0, 30000)}`
            });
          } else {
            parts.push({
              text: `Прикреплён файл «${name}» (${mime}). Формат не поддерживается для чтения.`
            });
          }
        }

        if (
          typeof body.message === 'string' &&
          body.message.trim()
        ) {
          parts.push({ text: body.message.slice(0, 16000) });
        }

        if (parts.length === 0) {
          res.writeHead(400, headers);
          return res.end(JSON.stringify({
            error: 'Добавь сообщение или вложение.'
          }));
        }

        contents.push({ role: 'user', parts });

        const mode = body.mode === 'coder' ? 'coder' : 'chat';

        const systemInstruction = mode === 'coder'
          ? 'Ты Liquid Coder — помощник по программированию. Отвечай на языке пользователя. Предлагай корректный код и инструкции по запуску.'
          : 'Ты Liquid — полезный ИИ-помощник. Отвечай на языке пользователя, понятно и структурированно, используя Markdown при необходимости.';

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': API_KEY
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: systemInstruction }]
              },
              contents,
              generationConfig: {
                temperature: mode === 'coder' ? 0.3 : 0.7,
                maxOutputTokens: 8192
              }
            })
          }
        );

        const result = await response.json();

        if (!response.ok) {
          console.error('Gemini API error:', response.status, result.error);

          res.writeHead(response.status, headers);
          return res.end(JSON.stringify({
            error: result.error?.message || `Gemini API вернул HTTP ${response.status}`
          }));
        }

        const answer = (
          result.candidates?.[0]?.content?.parts || []
        ).map(part => part.text || '').join('');

        if (!answer) {
          res.writeHead(502, headers);
          return res.end(JSON.stringify({
            error: 'Gemini не вернул текст. Попробуй отправить сообщение ещё раз.'
          }));
        }

        res.writeHead(200, headers);
        return res.end(JSON.stringify({
          answer,
          model: MODEL
        }));

      } catch (error) {
        console.error('Liquid server error:', error);

        if (!res.headersSent) {
          res.writeHead(500, headers);
          res.end(JSON.stringify({
            error: error instanceof SyntaxError
              ? 'Сервер получил некорректный JSON.'
              : 'Ошибка сервера при обращении к Gemini.'
          }));
        }
      }
    });

    return;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({
    error: 'Маршрут не найден.'
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Liquid server запущен на порту ${PORT}`);
  console.log(`Gemini model: ${MODEL}`);
  console.log(`Gemini API key configured: ${Boolean(API_KEY)}`);
});
