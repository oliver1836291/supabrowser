const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4500;

app.use(express.static(path.join(__dirname, 'public')));

const STRIP_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'content-encoding',
  'content-length',
]);

const REWRITE_ATTRS = ['href', 'src', 'action', 'poster', 'formaction'];

function proxied(targetUrl) {
  return '/fetch?url=' + encodeURIComponent(targetUrl);
}

function resolve(base, ref) {
  try { return new URL(ref, base).toString(); }
  catch (e) { return null; }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function rewriteHtml(html, baseUrl) {
  let out = html;

  for (const attr of REWRITE_ATTRS) {
    const re = new RegExp('(' + attr + '\\s*=\\s*)(["\'])(.*?)\\2', 'gi');
    out = out.replace(re, (m, pre, quote, rawVal) => {
      const val = decodeEntities(rawVal);
      if (/^(javascript:|data:|mailto:|tel:|#)/i.test(val.trim())) return m;
      const abs = resolve(baseUrl, val);
      if (!abs) return m;
      return pre + quote + proxied(abs) + quote;
    });
  }

  out = out.replace(/(srcset\s*=\s*)(["\'])(.*?)\2/gi, (m, pre, quote, rawVal) => {
    const val = decodeEntities(rawVal);
    const rewritten = val.split(',').map(part => {
      const seg = part.trim().split(/\s+/);
      const abs = resolve(baseUrl, seg[0]);
      if (!abs) return part.trim();
      seg[0] = proxied(abs);
      return seg.join(' ');
    }).join(', ');
    return pre + quote + rewritten + quote;
  });

  out = out.replace(/url\((['"]?)(.*?)\1\)/gi, (m, quote, val) => {
    if (/^(data:|#)/i.test(val.trim())) return m;
    const abs = resolve(baseUrl, val);
    if (!abs) return m;
    return 'url(' + quote + proxied(abs) + quote + ')';
  });

  const headTag = /<head[^>]*>/i;
  const injected = `
  <script>
    (function(){
      var BASE = ${JSON.stringify(baseUrl)};
      function toProxy(u){ try { return '/fetch?url=' + encodeURIComponent(new URL(u, BASE).toString()); } catch(e){ return u; } }
      var origOpen = window.XMLHttpRequest.prototype.open;
      window.XMLHttpRequest.prototype.open = function(method, url){ arguments[1] = toProxy(url); return origOpen.apply(this, arguments); };
      var origFetch = window.fetch;
      window.fetch = function(input, init){
        if (typeof input === 'string') input = toProxy(input);
        else if (input && input.url) input = toProxy(input.url);
        return origFetch.call(this, input, init);
      };
      document.addEventListener('click', function(e){
        var a = e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        var href = a.getAttribute('href');
        if (!href || /^(javascript:|#|mailto:|tel:)/i.test(href)) return;
      }, true);
      window.top.postMessage({ source: 'supabrowser', type: 'title', title: document.title, url: BASE }, '*');
    })();
  <\/script>
`;
  if (headTag.test(out)) out = out.replace(headTag, m => m + injected);
  else out = injected + out;

  return out;
}

async function handleFetch(req, res) {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url parameter');

  let parsed;
  try { parsed = new URL(target); }
  catch (e) { return res.status(400).send('Invalid URL'); }

  if (!/^https?:$/.test(parsed.protocol)) {
    return res.status(400).send('Only http/https URLs are supported');
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      method: req.method,
      redirect: 'follow',
      headers: {
        'User-Agent': req.get('user-agent') || 'Mozilla/5.0 (compatible; Supabrowser/1.0)',
        'Accept': req.get('accept') || '*/*',
        'Accept-Language': req.get('accept-language') || 'en-US,en;q=0.9',
        ...(req.method === 'POST' && req.get('content-type')
          ? { 'Content-Type': req.get('content-type') }
          : {}),
      },
      body: req.method === 'POST' ? req.body : undefined,
    });

    const finalUrl = upstream.url || parsed.toString();
    const contentType = upstream.headers.get('content-type') || '';

    upstream.headers.forEach((value, key) => {
      if (!STRIP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    });
    res.status(upstream.status);

    if (contentType.includes('text/html')) {
      const body = await upstream.text();
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(rewriteHtml(body, finalUrl));
    } else if (contentType.includes('text/css')) {
      const body = await upstream.text();
      const rewritten = body.replace(/url\((['"]?)(.*?)\1\)/gi, (m, quote, val) => {
        if (/^data:/i.test(val.trim())) return m;
        const abs = resolve(finalUrl, val);
        return abs ? `url(${quote}${proxied(abs)}${quote})` : m;
      });
      res.setHeader('content-type', 'text/css; charset=utf-8');
      res.send(rewritten);
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    }
  } catch (err) {
    res.status(502).send('Failed to load page: ' + err.message);
  }
}

app.get('/fetch', handleFetch);
app.post('/fetch', express.raw({ type: '*/*', limit: '20mb' }), handleFetch);

app.listen(PORT, () => {
  console.log(`supabrowser running at http://localhost:${PORT}`);
});
