export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const { imageBase64, mediaType, wordList } = body || {};

    // ── Generate similar wrong choices for multiple choice game ──
    const { distractorWord } = body || {};
    if (distractorWord) {
      const distRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: `Generate exactly 3 plausible misspellings of the word "${distractorWord}" that look similar to the correct spelling. These should be common mistakes a child might make — swapped letters, missing letters, extra letters, or phonetic errors.

Return ONLY a JSON array of 3 strings, nothing else. Example for "friend": ["freind","frend","friand"]`,
          }],
        }),
      });
      const distData = await distRes.json();
      const raw = distData.content?.[0]?.text ?? '[]';
      let distractors;
      try {
        distractors = JSON.parse(raw);
      } catch {
        const match = raw.match(/\[[\s\S]*\]/);
        distractors = match ? JSON.parse(match[0]) : [];
      }
      return res.status(200).json({ distractors });
    }
    if (wordList && Array.isArray(wordList)) {
      const spellRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: `Check if any of these words are misspelled. Return ONLY a JSON array of corrections for words that are actually misspelled. If all words are correct, return [].

Words to check: ${wordList.join(', ')}

Each correction must have:
- "wrong": the misspelled word as provided
- "correct": the correct spelling
- "context": ""

Only flag genuine misspellings. Do not flag proper nouns or intentional alternate spellings.`,
          }],
        }),
      });

      const spellData = await spellRes.json();
      const raw = spellData.content?.[0]?.text ?? '[]';
      let corrections;
      try {
        corrections = JSON.parse(raw);
      } catch {
        const match = raw.match(/\[[\s\S]*\]/);
        corrections = match ? JSON.parse(match[0]) : [];
      }
      return res.status(200).json({ corrections });
    }

    if (!imageBase64 || !mediaType) {
      return res.status(400).json({ error: 'Missing imageBase64 or mediaType' });
    }

    // ── PASS 1: Google Cloud Vision — transcribe handwriting ──
    const visionRes = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: imageBase64 },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
            imageContext: { languageHints: ['en'] },
          }],
        }),
      }
    );

    if (!visionRes.ok) {
      const err = await visionRes.text();
      return res.status(500).json({ error: 'Google Vision failed', detail: err });
    }

    const visionData = await visionRes.json();
    const transcript = visionData.responses?.[0]?.fullTextAnnotation?.text ?? '';

    if (!transcript.trim()) {
      return res.status(200).json({ words: [], transcript: 'No text detected in image.' });
    }

    // ── PASS 2: Claude — spell check the clean transcript ──
    const spellRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `The following is a transcription of a child's handwritten assignment. Find every misspelled word.

TRANSCRIPTION:
${transcript}

RULES:
- Only flag genuine spelling mistakes — words spelled incorrectly.
- Do NOT flag: proper nouns, names, places, titles, creative/invented words, or correct words.
- Do NOT flag grammar errors, punctuation errors, or capitalization — spelling only.
- If a word could reasonably be a valid alternate spelling or a name, do not flag it.

Return ONLY a valid JSON array, no other text, no markdown.
Each item must have:
- "wrong": the misspelled word exactly as it appears
- "correct": the correct standard spelling
- "context": the complete sentence it appeared in

If no spelling mistakes, return: []`,
        }],
      }),
    });

    if (!spellRes.ok) {
      const err = await spellRes.text();
      return res.status(500).json({ error: 'Spell check failed', detail: err });
    }

    const spellData = await spellRes.json();
    const raw = spellData.content?.[0]?.text ?? '[]';

    let words;
    try {
      words = JSON.parse(raw);
    } catch {
      const match = raw.match(/\[[\s\S]*\]/);
      words = match ? JSON.parse(match[0]) : [];
    }

    return res.status(200).json({ words, transcript });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
