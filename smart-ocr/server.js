const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 从环境变量读取智谱 API Key
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;

// 模型降级链：按优先级排序，遇 429 自动切换下一个
const VISION_MODELS = ['glm-4.6v-flash', 'glm-4.1v-thinking-flash', 'glm-4v-flash'];

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

// 单个模型的识别调用（内部函数）
async function callVisionModel(modelName, base64Data, prompt) {
    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${ZHIPU_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: modelName,
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
        const err = new Error(`模型 ${modelName} 返回 ${response.status}`);
        err.status = response.status;
        err.detail = errText;
        throw err;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    return { text: content, usage: data.usage, model: modelName };
}

// OCR 代理接口（带模型自动降级）
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

    // 遍历模型降级链
    let lastError = null;
    for (const modelName of VISION_MODELS) {
        try {
            console.log(`尝试使用模型: ${modelName}`);
            const result = await callVisionModel(modelName, base64Data, prompt);
            console.log(`模型 ${modelName} 识别成功`);
            return res.json({
                text: result.text,
                usage: result.usage,
                model: result.model
            });
        } catch (err) {
            lastError = err;
            // 如果是 429（限流/过载），自动切换到下一个模型
            if (err.status === 429) {
                console.warn(`模型 ${modelName} 触发限流(429)，尝试降级到下一个模型`);
                continue;
            }
            // 如果是 401/403，说明 Key 有问题，不用继续试了，直接返回
            if (err.status === 401 || err.status === 403) {
                console.error(`API Key 无效（${err.status}），停止降级`);
                return res.status(err.status).json({
                    error: `智谱 API Key 无效或未授权（${err.status}）`,
                    detail: err.detail
                });
            }
            // 其他错误（如 400 参数问题）也直接返回，避免掩盖问题
            console.error(`模型 ${modelName} 返回错误 ${err.status}，停止降级`);
            return res.status(err.status).json({
                error: `模型 ${modelName} 调用失败（${err.status}）`,
                detail: err.detail
            });
        }
    }

    // 所有模型都失败了
    console.error('所有免费视觉模型均被限流或不可用');
    return res.status(429).json({
        error: '所有免费视觉模型均被限流，请稍后重试（免费模型并发限制较严，建议错峰使用）',
        detail: lastError?.detail
    });
});

app.listen(PORT, () => {
    console.log(`✅ 服务已启动: http://localhost:${PORT}`);
    if (!ZHIPU_API_KEY) {
        console.warn('⚠️  未检测到 ZHIPU_API_KEY 环境变量');
    }
});

module.exports = app;
