const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = true;
const ENABLE_THINKING_MODE = true;

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'deepseek-ai/deepseek-v4-pro',
  'gpt-4-turbo': 'deepseek-ai/deepseek-v4-pro',
  'gpt-4o': 'deepseek-ai/deepseek-v4-pro',
  'claude-3-opus': 'deepseek-ai/deepseek-v4-pro',
  'claude-3-sonnet': 'deepseek-ai/deepseek-v4-pro',
  'gemini-pro': 'deepseek-ai/deepseek-v4-pro'
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens } = req.body;

    const shouldStream = true;
    let nimModel = MODEL_MAPPING[model] || model;

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature || 0.9,
      max_tokens: max_tokens || 32000,
      stream: shouldStream,
      ...(ENABLE_THINKING_MODE && { chat_template_kwargs: { thinking: true } })
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let buffer = '';
    let reasoningStarted = false;

    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      lines.forEach(line => {
        if (!line.startsWith('data: ')) return;
        if (line.includes('[DONE]')) { res.write(line + '\n'); return; }

        try {
          const data = JSON.parse(line.slice(6));
          if (data.choices?.[0]?.delta) {
            const reasoning = data.choices[0].delta.reasoning_content;
            const content = data.choices[0].delta.content;

            if (SHOW_REASONING) {
              let combined = '';
              if (reasoning && !reasoningStarted) { combined = '<think>\n' + reasoning; reasoningStarted = true; }
              else if (reasoning) { combined = reasoning; }
              if (content && reasoningStarted) { combined += '</think>\n\n' + content; reasoningStarted = false; }
              else if (content) { combined += content; }
              if (combined) data.choices[0].delta.content = combined;
            } else {
              data.choices[0].delta.content = content || '';
            }
            delete data.choices[0].delta.reasoning_content;
          }
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) { res.write(line + '\n'); }
      });
    });

    response.data.on('end', () => res.end());
    response.data.on('error', () => res.end());

  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: { message: error.message || 'Internal server error', type: 'invalid_request_error' }
    });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found` } });
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
