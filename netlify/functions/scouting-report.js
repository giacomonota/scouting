// Netlify serverless function — holds the Anthropic API key safely on the server side.
// Never runs in the browser, so the key is never exposed to visitors.
// URL once deployed: https://YOUR-SITE.netlify.app/.netlify/functions/scouting-report

const SUPA_URL = 'https://pmwcwdvxzmudgtbctozy.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtd2N3ZHZ4em11ZGd0YmN0b3p5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MjE5NjEsImV4cCI6MjEwMjE5Nzk2MX0.HiAKs6GtlHbXZst5ZlHiyUKzDSbObB5vkah46Ip_Eqs';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Verify the caller is actually logged in before spending anything on the API —
  // stops random visitors to the URL from running up costs.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not logged in.' }) };
  }
  try {
    const authCheck = await fetch(SUPA_URL + '/auth/v1/user', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + token }
    });
    if (!authCheck.ok) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Session invalid or expired.' }) };
    }
  } catch (e) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Could not verify login.' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in Netlify → Site settings → Environment variables.' })
    };
  }

  let name, position, club;
  try {
    const body = JSON.parse(event.body || '{}');
    name = body.name;
    position = body.position;
    club = body.club;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }
  if (!name) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Player name is required.' }) };
  }

  // Structure follows the FA's "four corners" model used by professional academies:
  // technical / physical / mental-tactical / social, plus strengths, weaknesses,
  // recent form and a clear recommendation. Statistical profile, ceiling estimate
  // and comparable players are already covered by our own database elsewhere in
  // the card, so this only asks for the parts that genuinely need research.
  const prompt = `Search the web and research the football player "${name}"` +
    (position ? ` (${position})` : '') + (club ? `, currently at ${club}` : '') + `.
Write a professional-style scouting report covering technical ability, physical attributes, and mental/tactical qualities, following the structure academy scouts use.

Respond with ONLY a raw JSON object, no markdown fences, no other text, in exactly this shape:
{
  "found": true or false,
  "playing_style": "2-3 sentence executive summary of the player's overall game",
  "technical": "2-3 sentences on first touch, passing, dribbling, shooting/heading, weaker foot",
  "physical": "1-2 sentences on pace, strength, stamina, agility",
  "mental_tactical": "1-2 sentences on decision-making, positioning, work rate, attitude",
  "strengths": ["short phrase", "short phrase", "short phrase"],
  "weaknesses": ["short phrase", "short phrase"],
  "recent_form": "1-2 sentences on how they've been playing lately",
  "recommendation": "one sentence: sign / monitor / watch closely / not a fit, with a brief reason",
  "highlights_url": "a video URL if you find one, else null"
}

If you cannot find reliable information about this specific player, set "found" to false, put a brief explanation in "playing_style", and leave the other text fields as empty strings or empty arrays. Paraphrase everything in your own words from what you find — never quote source text directly.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });

    const data = await resp.json();
    if (data.error) {
      return { statusCode: 502, body: JSON.stringify({ error: data.error.message || 'Anthropic API error' }) };
    }

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const clean = text.replace(/```json|```/g, '').trim();

    let report;
    try {
      report = JSON.parse(clean);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not parse the report.', raw: clean.slice(0, 300) }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report)
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Could not reach Anthropic: ' + e.message }) };
  }
};
