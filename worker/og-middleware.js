// 文癖：リンクをSNSに貼ったときのプレビュー（OGP）を整える
// ・画像やページのURLを、公開しているドメインに合わせた完全なURLにする
// ・短い対戦リンク（?b=ID）なら「◯◯から挑戦状！」というタイトルにする
// 文癖のページ（<meta name="buntai-beast">があるページ）だけを書きかえる。ほかのページはそのまま。
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname.includes('/api/')) return next();
  const res = await next();
  if (!(res.headers.get('Content-Type') || '').includes('text/html')) return res;

  let title = null, desc = null;
  const bid = url.searchParams.get('b');
  if (bid && /^[a-z0-9]{6,32}$/.test(bid) && env.DB) {
    try {
      const row = await env.DB.prepare('SELECT name FROM links WHERE id = ?1').bind(bid).first();
      if (row) { title = `「${row.name}」から挑戦状！｜文癖`; desc = 'きみの文章もキャラにして、受けて立とう。文章を貼るだけ、1分で対戦。'; }
    } catch (e) { /* プレビューが変わらないだけなので無視 */ }
  } else if (url.searchParams.get('vs')) {
    title = '挑戦状が届いています！｜文癖';
  }
  const dir = url.pathname.endsWith('/') ? url.pathname : url.pathname.replace(/[^/]*$/, '');
  const img = url.origin + dir + 'og.png';
  const pageUrl = url.origin + url.pathname + (bid ? `?b=${bid}` : '');

  let ours = false;
  const set = (v) => ({ element(e) { if (ours && v) e.setAttribute('content', v); } });
  return new HTMLRewriter()
    .on('meta[name="buntai-beast"]', { element() { ours = true; } })
    .on('meta[property="og:image"]', set(img))
    .on('meta[name="twitter:image"]', set(img))
    .on('meta[property="og:url"]', set(pageUrl))
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(desc))
    .on('meta[name="twitter:description"]', set(desc))
    .transform(res);
}
