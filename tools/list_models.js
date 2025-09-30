const fs = require('fs');
const path = require('path');

// load .env if present (simple parser)
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  const m = content.match(/^\s*GEMINI_API_KEY\s*=\s*(.+)\s*$/m);
  if (m) process.env.GEMINI_API_KEY = m[1].trim();
}

(async () => {
  try {
    const svc = require('../src/services/llm.service.js');

    // wait briefly for async init
    await new Promise((r) => setTimeout(r, 1500));

    console.log('CLIENT_PRESENT', !!svc.client);
    console.log('CHOSEN_MODEL', svc.chosenModel);

    if (svc.client && typeof svc.client.listModels === 'function') {
      try {
        const list = await svc.client.listModels();
        console.log('LIST_MODELS_RESULT (truncated):', JSON.stringify(list, null, 2).slice(0, 4000));
      } catch (e) {
        console.error('LIST_MODELS_ERROR:', e && e.message);
        if (e && e.response) console.error('LIST_MODELS_ERROR_BODY:', e.response);
      }
    } else {
      console.log('Client does not support listModels or client not initialized');
    }
  } catch (e) {
    console.error('ERROR', e && (e.message || e));
  }
})();
