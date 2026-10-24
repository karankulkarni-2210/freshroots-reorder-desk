// Drafts AI briefs for the judgment queue. Only signed-in Editors may call it; the Anthropic key never leaves the server.
import Anthropic from '@anthropic-ai/sdk';
import { supabaseUrl, supabaseKey } from './_config.mjs';

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// Supabase checks the caller's token; the members table (under its own access rules) says whether they are an Editor.
async function isEditor(authorization) {
  if (!/^Bearer \S+$/.test(authorization || '')) return false;
  const headers = { apikey: supabaseKey, authorization };
  const me = await fetch(`${supabaseUrl}/auth/v1/user`, { headers }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!me || !me.id) return false;
  const rows = await fetch(`${supabaseUrl}/rest/v1/members?select=role&user_id=eq.${encodeURIComponent(me.id)}`, { headers })
    .then(r => (r.ok ? r.json() : [])).catch(() => []);
  return Array.isArray(rows) && rows.length > 0 && rows[0].role === 'editor';
}

// The page asks for a JSON array of briefs: take the text from the first [ to the last ].
export function parseArray(text) {
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ code: 'invalid_request', message: 'POST only.' });
  if (!(await isEditor(req.headers.authorization))) return res.status(403).json({ code: 'not_granted', message: 'Sign in as an Editor to draft briefs.' });
  if (!client) return res.status(503).json({ code: 'sampling_disabled', message: 'ANTHROPIC_API_KEY is not set on the server.' });
  const prompt = req.body && typeof req.body.prompt === 'string' ? req.body.prompt : '';
  if (!prompt || prompt.length > 200000) return res.status(400).json({ code: 'invalid_request', message: 'Send a prompt under 200,000 characters.' });
  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low' },   // short summaries of numbers already worked out; keeps a 6-SKU batch inside the 60 s limit
      // On a safety decline, Anthropic re-runs the request on its recommended fallback model within the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') return res.status(422).json({ code: 'refused', message: 'Claude declined to draft these briefs.' });
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const result = parseArray(text);
    if (!result) return res.status(502).json({ code: 'invalid_json', message: 'The reply held no JSON array of briefs.' });
    return res.status(200).json({ result });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ code: 'rate_limited', message: e.message });
    if (e instanceof Anthropic.AuthenticationError) return res.status(503).json({ code: 'sampling_disabled', message: 'The Anthropic key was rejected.' });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ code: 'upstream_error', message: e.message });
    throw e;
  }
}
