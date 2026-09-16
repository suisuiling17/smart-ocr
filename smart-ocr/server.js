const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 平台配置
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY;

const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1/chat/completions';

// 降级链：按优先级排序
// 注意：glm-4v-flash 不支持 Base64，会被跳过（除非有图片URL）
const MODEL_CHAIN = [
    { platform: 'zhipu', model: 'glm-4.6v-flash', supportsBase64: true, needsMaxTokens: false },
    { platform: 'zhipu', model: 'glm-4.1v-thinking-flash', supportsBase64: true, needsMaxTokens: false },
    { platform: 'siliconflow', model: 'deepseek-ai/DeepSeek-OCR', supportsBase64: true, needsMaxTokens: true }
];

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        hasZhipuKey: !!ZHIPU_API_KEY,
        hasSiliconflowKey: !!SILICONFLOW_API_KEY
    });
});

async function callModel(config, base64Data, prompt) {
    const { platform, model, needsMaxTokens } = config;

    // 根据平台选择 API Key 和 Endpoint
    let apiKey, apiUrl;
    if (platform === 'zhipu') {
        apiKey = ZHIPU_API_KEY;
        apiUrl = ZHIPU_BASE_URL;
    } else if (platform === 'siliconflow') {
        apiKey = SILICONFLOW_API_KEY;
        apiUrl = SILICONFLOW_BASE_URL;
    }

    if (!apiKey) {
        throw new Error(`平台 ${platform} 未配置 API Key`);
    }

    // 构造请求体
    const requestBody = {
        model: model,
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
                { type: 'text', text: prompt }
            ]
        }]
    };

    // 根据模型特性决定是否添加 max_tokens
    // glm-4.6v-flash 和 glm-4.1v-thinking-flash 可以传，但要注意 glm-4v-flash 的 1024 限制
    if (needsMaxTokens) {
        requestBody.max_tokens = 2048;
    }

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errText = await response.text();
        const err = new Error(`[${platform}] ${model} 返回 ${response.status}`);
        err.status = response.status;
        err.detail = errText;
        throw err;
    }

    const data = await response.json();
    return {
        text: data.choices?.[0]?.message?.content || '',
        usage: data.usage,
        model: model,
        platform: platform
    };
}

app.post('/api/ocr', async (req, res) => {
    if (!ZHIPU_API_KEY && !SILICONFLOW_API_KEY) {
        return res.status(500).json({ error: '服务器未配置任何平台的 API Key' });
    }

    const { imageBase64, mode } = req.body;
    if (!imageBase64) {
        return res.status(400).json({ error: '缺少 imageBase64 参数' });
    }

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // 强制直接输出，减少响应时间
    const prompt = mode === 'structured'
        ? `直接输出以下 JSON，不要解释、不要 markdown 代码块，只输出一行 JSON：
{"活动名称":"","时间":"","地点":"","主办单位":"","参与人员":"","全文":""}`
        : `直接输出图片中的所有文字，按原文顺序，不要任何解释。`;

    let lastError = null;
    for (const config of MODEL_CHAIN) {
        try {
            // 跳过不支持的模型
            if (!config.supportsBase64) {
                continue;
            }

            console.log(`尝试: [${config.platform}] ${config.model}`);
            const result = await callModel(config, base64Data, prompt);
            console.log(`成功: [${result.platform}] ${result.model}`);
            return res.json({
                text: result.text,
                usage: result.usage,
                model: result.model,
                platform: result.platform
            });
        } catch (err) {
            lastError = err;
            console.warn(`失败: ${err.message}`);

            // 400 参数错误、429 限流、5xx 服务端错误 → 都继续降级
            if (err.status === 400 || err.status === 429 || err.status >= 500) {
                continue;
            }

            // 401/403 Key 问题 → 如果是当前平台唯一的 Key，停止；否则继续尝试其他平台
            if (err.status === 401 || err.status === 403) {
                // 检查是否还有其他平台的 Key 可用
                const hasOtherPlatform = MODEL_CHAIN.some(c => 
                    c.platform !== config.platform && 
                    c.supportsBase64 && 
                    ((c.platform === 'zhipu' && ZHIPU_API_KEY) || (c.platform === 'siliconflow' && SILICONFLOW_API_KEY))
                );
                if (!hasOtherPlatform) {
                    return res.status(err.status).json({ error: `API Key 无效（${err.status}）`, detail: err.detail });
                }
                continue;
            }

            // 其他未知错误 → 停止降级，避免死循环
            return res.status(err.status || 500).json({
                error: `[${config.platform}] ${config.model} 调用失败（${err.status}）`,
                detail: err.detail
            });
        }
    }

    // 所有模型都失败
    return res.status(503).json({
        error: '所有免费视觉模型均不可用，请稍后重试或检查 API Key 配置',
        detail: lastError?.detail
    });
});

app.listen(PORT, () => {
    console.log(`✅ 服务已启动: http://localhost:${PORT}`);
    if (!ZHIPU_API_KEY) console.warn('⚠️  未配置 ZHIPU_API_KEY');
    if (!SILICONFLOW_API_KEY) console.warn('⚠️  未配置 SILICONFLOW_API_KEY');
});

module.exports = app;
