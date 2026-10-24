
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'Flash';
const MAX_BODY = 18 * 1024 * 1024;

const server = http.createServer(async (req, res) => {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
    };

    // Открытие интерфейса Liquid
    if (
        req.method === 'GET' &&
        (req.url === '/' || req.url === '/liquid.html')
    ) {
        const htmlPath = path.join(__dirname, 'liquid.html');

        if (!fs.existsSync(htmlPath)) {
            res.writeHead(404, headers);
            return res.end(JSON.stringify({
                error: 'Файл liquid.html не найден'
            }));
        }

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Content-Type-Options': 'nosniff'
        });

        return fs.createReadStream(htmlPath).pipe(res);
    }

    // Проверка API
    if (req.method === 'GET' && req.url === '/api/health') {
        res.writeHead(200, headers);
        return res.end(JSON.stringify({
            status: 'ok',
            model: MODEL,
            apiKeyConfigured: Boolean(API_KEY)
        }));
    }

    // Обработка сообщений чата
    if (req.method === 'POST' && req.url === '/api/chat') {
        if (!API_KEY) {
            res.writeHead(500, headers);
            return res.end(JSON.stringify({
                error: 'Не задан GEMINI_API_KEY в переменных окружения'
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

                const contents = history.map(item => ({
                    role: item.role === 'user' ? 'user' : 'model',
                    parts: [{
                        text: String(item.text || '').slice(0, 16000)
                    }]
                }));

                const parts = [];
                const attachments = Array.isArray(body.attachments)
                    ? body.attachments.slice(0, 8)
                    : [];

                for (const file of attachments) {
                    if (typeof file.data !== 'string') continue;

                    const name = String(file.name || 'file').slice(0, 160);
                    const mime = String(
                        file.mimeType || 'application/octet-stream'
                    );

                    if (mime.startsWith('image/') || mime === 'application/pdf') {
                        parts.push({
                            text: `Прикреплён файл: ${name}`
                        });

                        parts.push({
                            inlineData: {
                                mimeType: mime,
                                data: file.data
                            }
                        });
                    } else if (
                        /^(text\/|application\/(json|xml|javascript|x-python|x-sh|typescript))/i.test(mime) ||
                        /\.(txt|md|js|jsx|ts|tsx|py|java|kt|html|css|json|xml|csv|yml|yaml|sql|sh)$/i.test(name)
                    ) {
                        let decoded = file.data;

                        try {
                            decoded = Buffer.from(file.data, 'base64')
                                .toString('utf8');
                        } catch {}

                        parts.push({
                            text: `Содержимое файла ${name}:\n${decoded.slice(0, 30000)}`
                        });
                    }
                }

                if (typeof body.message === 'string' && body.message.trim()) {
                    parts.push({
                        text: body.message.slice(0, 16000)
                    });
                }

                if (parts.length > 0) {
                    contents.push({
                        role: 'user',
                        parts
                    });
                }

                if (!contents.length) {
                    res.writeHead(400, headers);
                    return res.end(JSON.stringify({
                        error: 'Добавь сообщение или вложение'
                    }));
                }

                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': API_KEY
                        },
                        body: JSON.stringify({
                            contents,
                            generationConfig: {
                                temperature: 0.7,
                                maxOutputTokens: 8192
                            }
                        })
                    }
                );

                const result = await response.json();

                if (!response.ok) {
                    res.writeHead(response.status, headers);
                    return res.end(JSON.stringify({
                        error: result.error?.message || 'Ошибка Gemini API'
                    }));
                }

                const answer = (result.candidates?.[0]?.content?.parts || [])
                    .map(part => part.text || '')
                    .join('');

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
                        error: 'Внутренняя ошибка сервера'
                    }));
                }
            }
        });

        return;
    }

    res.writeHead(404, headers);
    res.end(JSON.stringify({
        error: 'Маршрут не найден'
    }));
});

server.listen(PORT, () => {
    console.log(`Liquid server запущен на порту ${PORT}`);
});
