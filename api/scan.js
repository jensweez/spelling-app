export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { imageBase64, mediaType } = body;

    if (!imageBase64 || !mediaType) {
      console.error('scan.js: missing fields', { hasImage: !!imageBase64, mediaType });
      return res.status(400).json({ error: 'Missing imageBase64 or mediaType' });
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };

    // PASS 1: Transcribe the handwriting exactly as written
    const transcribeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: imageBase64 },
            },
            {
              type: 'text',
              text: `This is a photo of a child's handwritten assignment. Your ONLY job is to transcribe exactly what you see — every word, exactly as the child wrote it, mistakes and all.

RULES:
- Copy the text exactly as written. Do NOT fix any spelling, grammar, or punctuation.
- Preserve the child's exact words including any misspellings.
- If a word is hard to read, make your best guess at what letters were written.
- Include all sentences, even incomplete ones.
- Do not add any commentary, labels, or explanations — just the raw transcribed text.

Output the transcription only, nothing else.`,
            },
          ],
        }],
      }),
    });

    if (!transcribeRes.ok) {
      const err = await transcribeRes.text();
      console.error('scan.js: transcription pass failed', {
        status: transcribeRes.status,
        statusText: transcribeRes.statusText,
        body: err,
      });
      return res.status(500).json({ error: 'Transcription failed', detail: err });
    }

    const transcribeData = await transcribeRes.json();
    const transcript = transcribeData.content?.[0]?.text ?? '';
    console.log('scan.js: transcription succeeded, length', transcript.length);

    if (!transcript.trim()) {
      return res.status(200).json({ words: [], transcript: '' });
    }

    // PASS 2: Spell check the clean transcript
    const spellRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `The following is a transcription of a child's handwritten assignment. Find every misspelled word.

TRANSCRIPTION:
${transcript}

RULES:
- Only flag genuine spelling mistakes — words spelled incorrectly.
- Do NOT flag: proper nouns, names, places, creative/invented words, or correct words.
- Do NOT flag grammar errors, punctuation errors, or capitalization — spelling only.
- If a word could reasonably be a valid alternate spelling or a name, do not flag it.

Return ONLY a valid JSON array, no other text, no markdown, no explanation.
Each item must have exactly:
- "wrong": the misspelled word exactly as it appears in the transcription
- "correct": the correct standard spelling
- "context": the complete sentence it appeared in (copied exactly from the transcription)

If no spelling mistakes, return: []

Example: [{"wrong":"becaus","correct":"because","context":"I stayed home becaus I was sick"}]`,
        }],
      }),
    });

    if (!spellRes.ok) {
      const err = await spellRes.text();
      console.error('scan.js: spell check pass failed', {
        status: spellRes.status,
        statusText: spellRes.statusText,
        body: err,
      });
      return res.status(500).json({ error: 'Spell check failed', detail: err });
    }

    const spellData = await spellRes.json();
    const raw = spellData.content?.[0]?.text ?? '[]';

    let words;
    try {
      words = JSON.parse(raw);
    } catch (parseErr) {
      console.error('scan.js: could not parse spell check JSON', { raw, parseErr: parseErr.message });
      const match = raw.match(/\[[\s\S]*\]/);
      words = match ? JSON.parse(match[0]) : [];
    }

    console.log('scan.js: spell check succeeded, words found', words.length);
    return res.status(200).json({ words, transcript });

  } catch (err) {
    console.error('scan.js: unhandled exception', { message: err.message, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
}
