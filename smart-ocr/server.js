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

// 降级链：按优先级排序（全部免费模型）
const MODEL_CHAIN = [
    { platform: 'zhipu', model: 'glm-4.6v-flash', supportsBase64: true, needsMaxTokens: false },
    { platform: 'zhipu', model: 'glm-4.1v-thinking-flash', supportsBase64: true, needsMaxTokens: false },
    { platform: 'siliconflow', model: 'deepseek-ai/DeepSeek-OCR', supportsBase64: true, needsMaxTokens: true }
];

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================
// 健康检查
// =========================================================
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        hasZhipuKey: !!ZHIPU_API_KEY,
        hasSiliconflowKey: !!SILICONFLOW_API_KEY
    });
});

// =========================================================
// 调用单个视觉模型
// =========================================================
async function callVisionModel(config, base64Data, prompt) {
    const { platform, model, needsMaxTokens } = config;

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

// =========================================================
// OCR 代理接口（带模型自动降级）
// =========================================================
app.post('/api/ocr', async (req, res) => {
    if (!ZHIPU_API_KEY && !SILICONFLOW_API_KEY) {
        return res.status(500).json({ error: '服务器未配置任何平台的 API Key' });
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
    for (const config of MODEL_CHAIN) {
        try {
            if (!config.supportsBase64) continue;
            console.log(`尝试: [${config.platform}] ${config.model}`);
            const result = await callVisionModel(config, base64Data, prompt);
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

            if (err.status === 400 || err.status === 429 || err.status >= 500) {
                continue;
            }

            if (err.status === 401 || err.status === 403) {
                const hasOther = MODEL_CHAIN.some(c =>
                    c.platform !== config.platform &&
                    c.supportsBase64 &&
                    ((c.platform === 'zhipu' && ZHIPU_API_KEY) || (c.platform === 'siliconflow' && SILICONFLOW_API_KEY))
                );
                if (!hasOther) {
                    return res.status(err.status).json({ error: `API Key 无效（${err.status}）`, detail: err.detail });
                }
                continue;
            }

            return res.status(err.status || 500).json({
                error: `[${config.platform}] ${config.model} 调用失败（${err.status}）`,
                detail: err.detail
            });
        }
    }

    return res.status(503).json({
        error: '所有免费视觉模型均不可用，请稍后重试',
        detail: lastError?.detail
    });
});

// =========================================================
// AI 分类接口（供前端"自定义维度"使用）
// =========================================================
app.post('/api/classify', async (req, res) => {
    const { mode, dimension, dimensionDesc, content, context } = req.body;

    if (!ZHIPU_API_KEY && !SILICONFLOW_API_KEY) {
        return res.status(500).json({ error: '未配置任何平台的 API Key' });
    }

    if (mode !== 'classify' || !dimension) {
        return res.status(400).json({ error: '参数错误' });
    }

    const prompt = `你是一个文档分类助手。请阅读以下文档内容，判断该文档在「${dimension}」这个维度下应该归到哪一类。
${dimensionDesc ? `维度说明：${dimensionDesc}` : ''}

要求：
1. 只输出归类结果，不要任何解释、前缀、引号。
2. 归类结果要简短（不超过 8 个字）。
3. 如果无法判断，输出"未识别"。

已知字段：
- 活动名称：${context?.event || '无'}
- 时间：${context?.time || '无'}
- 地点：${context?.location || '无'}
- 人物/单位：${context?.people || '无'}

文档内容：
${(content || '').substring(0, 2000)}

请直接输出归类结果：`;

    let lastError = null;
    for (const config of MODEL_CHAIN) {
        try {
            if (!config.supportsBase64) continue;
            const apiKey = config.platform === 'zhipu' ? ZHIPU_API_KEY : SILICONFLOW_API_KEY;
            if (!apiKey) continue;
            const apiUrl = config.platform === 'zhipu' ? ZHIPU_BASE_URL : SILICONFLOW_BASE_URL;

            const requestBody = {
                model: config.model,
                messages: [{ role: 'user', content: prompt }]
            };
            if (config.needsMaxTokens) requestBody.max_tokens = 50;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const err = new Error(`分类失败 ${response.status}`);
                err.status = response.status;
                if (response.status === 400 || response.status === 429 || response.status >= 500) {
                    lastError = err;
                    continue;
                }
                throw err;
            }

            const data = await response.json();
            let result = (data.choices?.[0]?.message?.content || '').trim();
            result = result
                .replace(/^["'「『]|["'」』]$/g, '')
                .replace(/^归类[:：]?\s*/, '')
                .replace(/^结果[:：]?\s*/, '')
                .split('\n')[0]
                .trim()
                .substring(0, 20);

            return res.json({ result: result || '未识别', model: config.model });
        } catch (err) {
            lastError = err;
            if (err.status === 400 || err.status === 429 || err.status >= 500) continue;
            return res.status(err.status || 500).json({ error: err.message });
        }
    }

    return res.status(503).json({ error: '所有免费模型均不可用', detail: lastError?.message });
});

app.listen(PORT, () => {
    console.log(`✅ 服务已启动: http://localhost:${PORT}`);
    if (!ZHIPU_API_KEY) console.warn('⚠️  未配置 ZHIPU_API_KEY');
    if (!SILICONFLOW_API_KEY) console.warn('⚠️  未配置 SILICONFLOW_API_KEY');
});

module.exports = app;
