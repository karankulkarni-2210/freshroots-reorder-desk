// Builds the Vercel site from the same index.html that is published to Claude: wraps it in a full document and
// loads the Supabase stand-in for Claude's runtime (platform.js) before the page's own scripts.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { supabaseUrl, supabaseKey } from './api/_config.mjs';

const out = 'public';
mkdirSync(out, { recursive: true });
const head = `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="config.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js"></script>
<script src="platform.js"></script>
</head>
<body>
`;
writeFileSync(`${out}/index.html`, head + readFileSync('index.html', 'utf8') + '\n</body>\n</html>\n');
writeFileSync(`${out}/config.js`, `window.DESK_CONFIG = ${JSON.stringify({ supabaseUrl, supabaseKey })};\n`);
for (const f of ['engine.js', 'charts.js', 'moss.jpg', 'platform.js']) copyFileSync(f, `${out}/${f}`);
console.log(`Built ${out}/ from index.html`);
