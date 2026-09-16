const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 从环境变量读取智谱 API Key（Vercel 中配置）
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        hasKey: !!ZHIPU_API_KEY
    });
});

// OCR 代理接口
app.post('/api/ocr', async (req, res) => {
    if (!ZHIPU_API_KEY) {
        return res.status(500).json({ error: '服务器未配置 ZHIPU_API_KEY 环境变量' });
    }

    const { imageBase64, mode } = req.body;

    if (!imageBase64) {
        return res.status(400).json({ error: '缺少 imageBase64 参数' });
    }

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const prompt = mode === 'structured'
        ? `请识别图片中的文字，并以严格的 JSON 格式返回，不要有任何多余文字：
{
  "活动名称": "从图片中提取的活动/事件名称，如果没有则填空字符串",
  "时间": "活动时间，如果没有则填空字符串",
  "地点": "活动地点，如果没有则填空字符串",
  "主办单位": "主办/承办单位，如果没有则填空字符串",
  "参与人员": "参与人员或负责人，如果没有则填空字符串",
  "全文": "图片中的完整文字内容"
}`
        : `请识别这张图片中的所有文字，按原文顺序输出，不要添加任何解释、评论或格式标记。`;

    try {
        const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ZHIPU_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'glm-4.6v-flash',
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${base64Data}` }
                        },
                        { type: 'text', text: prompt }
                    ]
                }],
                max_tokens: 4096,
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('智谱 API 错误:', response.status, errText);
            return res.status(response.status).json({
                error: `智谱 API 返回 ${response.status}`,
                detail: errText
            });
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        res.json({
            text: content,
            usage: data.usage
        });

    } catch (err) {
        console.error('代理请求失败:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ 服务已启动: http://localhost:${PORT}`);
    if (!ZHIPU_API_KEY) {
        console.warn('⚠️  未检测到 ZHIPU_API_KEY 环境变量');
    }
});

module.exports = app;