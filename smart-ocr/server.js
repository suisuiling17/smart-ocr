const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;

// 仅使用免费视觉模型，按速度优先级排序
const VISION_MODELS = ['glm-4v-flash', 'glm-4.6v-flash', 'glm-4.1v-thinking-flash'];

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
    res.json({ ok: true, hasKey: !!ZHIPU_API_KEY });
});

async function callVisionModel(modelName, base64Data, prompt) {
    // 基础请求体
    const requestBody = {
        model: modelName,
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
                { type: 'text', text: prompt }
            ]
        }]
    };

    // glm-4v-flash 不支持 max_tokens / temperature 等参数，传了会返回 400
    // 其他模型可以保留这两个参数
    if (modelName !== 'glm-4v-flash') {
        requestBody.max_tokens = 1500;
        requestBody.temperature = 0.1;
    }

    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${ZHIPU_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errText = await response.text();
        const err = new Error(`模型 ${modelName} 返回 ${response.status}`);
        err.status = response.status;
        err.detail = errText;
        throw err;
    }

    const data = await response.json();
    return { text: data.choices?.[0]?.message?.content || '', usage: data.usage, model: modelName };
}

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
        ? `直接输出以下 JSON，不要解释、不要 markdown 代码块，只输出一行 JSON：
{"活动名称":"","时间":"","地点":"","主办单位":"","参与人员":"","全文":""}`
        : `直接输出图片中的所有文字，按原文顺序，不要任何解释。`;

    let lastError = null;
    for (const modelName of VISION_MODELS) {
        try {
            console.log(`尝试使用免费模型: ${modelName}`);
            const result = await callVisionModel(modelName, base64Data, prompt);
            console.log(`模型 ${modelName} 识别成功`);
            return res.json({ text: result.text, usage: result.usage, model: result.model });
        } catch (err) {
            lastError = err;
            // 429 限流 → 自动切换下一个模型
            if (err.status === 429) {
                console.warn(`模型 ${modelName} 限流，降级到下一个免费模型`);
                continue;
            }
            // 401/403 Key 问题 → 直接返回
            if (err.status === 401 || err.status === 403) {
                return res.status(err.status).json({ error: `API Key 无效或未授权（${err.status}）`, detail: err.detail });
            }
            // 400 参数问题 → 也尝试降级（有些模型对参数敏感）
            if (err.status === 400) {
                console.warn(`模型 ${modelName} 返回 400 参数错误，尝试下一个模型`);
                continue;
            }
            // 其他错误 → 直接返回
            return res.status(err.status).json({ error: `模型 ${modelName} 调用失败（${err.status}）`, detail: err.detail });
        }
    }

    return res.status(429).json({
        error: '所有免费视觉模型均不可用，请稍后重试',
        detail: lastError?.detail
    });
});

app.listen(PORT, () => {
    console.log(`✅ 服务已启动: http://localhost:${PORT}`);
    if (!ZHIPU_API_KEY) console.warn('⚠️  未检测到 ZHIPU_API_KEY 环境变量');
});

module.exports = app;
