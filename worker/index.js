// nakata-ataru.com の入口。静的ファイルは Workers Assets がそのまま返し、
// ここを通るのは wrangler.jsonc の run_worker_first に書いたパスだけ。
//   /api/buntai/*                文癖（ブンペキ）のAPI（D1）
//   /bunpeki/ , /bunpeki/index.html   文癖のページ（リンクプレビュー用に meta を書きかえる）
import { onRequest as buntaiApi } from './buntai-api.js';
import { onRequest as ogRewrite } from './og-middleware.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/buntai/')) {
      const path = url.pathname.slice('/api/buntai/'.length).split('/').filter(Boolean);
      return buntaiApi({ request, env, ctx, params: { path } });
    }
    return ogRewrite({ request, env, ctx, next: () => env.ASSETS.fetch(request) });
  },
};
