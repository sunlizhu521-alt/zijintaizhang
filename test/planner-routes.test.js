import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFixture } from './helpers.js';

test('计划管理独立入口和资源可用，旧入口转向且不影响资金及订单页面', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'planner-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../public/jihuaguanli/', import.meta.url));
  await cp(source, join(directory, 'jihuaguanli'), { recursive: true });
  const funds = '<!doctype html><html><head><title>资金台账</title><meta name="description" content="资金台账原页面"></head><body><script src="/zijintaizhang/assets/funds.js"></script></body></html>';
  await writeFile(join(directory, 'index.html'), funds);
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'assets/funds.js'), '/* existing funds asset */');
  const f = await appFixture(t, { distDir: directory });

  const page = await fetch(`${f.origin}/jihuaguanli/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>计划管理 · WorkBuddy<\/title>/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /href="\.\/style\.css"/);
  for (const name of ['app.js', 'logic.js', 'style.css', 'icon.svg']) {
    const asset = await fetch(`${f.origin}/jihuaguanli/${name}`);
    assert.equal(asset.status, 200, name);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile(join(source, name)));
    const oldAsset = await fetch(`${f.origin}/zijintaizhang/jihuaguanli/${name}`, { redirect: 'manual' });
    assert.equal(oldAsset.status, 200, `legacy ${name}`);
    assert.deepEqual(Buffer.from(await oldAsset.arrayBuffer()), await readFile(join(source, name)));
  }
  for (const path of ['/jihuaguanli', '/zijintaizhang/jihuaguanli', '/zijintaizhang/jihuaguanli/']) {
    const redirected = await fetch(`${f.origin}${path}`, { redirect: 'manual' });
    assert.equal(redirected.status, 308, path);
    assert.equal(redirected.headers.get('location'), '/jihuaguanli/');
  }
  for (const path of ['/jihuaguanli/unknown', '/jihuaguanli-other/', '/jihuaguanli/api/planner']) {
    assert.equal((await fetch(`${f.origin}${path}`)).status, 404, path);
  }
  assert.equal(await (await fetch(`${f.origin}/zijintaizhang/`)).text(), funds);
  assert.equal(await (await fetch(`${f.origin}/zijintaizhang/assets/funds.js`)).text(), '/* existing funds asset */');
  const orders = await fetch(`${f.origin}/caigoudingdangenjin/`);
  assert.equal(orders.status, 200);
  assert.match(await orders.text(), /<title>采购订单跟进<\/title>/);
  const orderRedirect = await fetch(`${f.origin}/caigoudingdangenjin`, { redirect: 'manual' });
  assert.equal(orderRedirect.status, 308);
  assert.equal(orderRedirect.headers.get('location'), '/caigoudingdangenjin/');

  assert.equal((await f.request('/planner?date=2026-11-15')).status, 401);
  const session = await f.login();
  assert.match(session.headers.get('set-cookie'), /Path=\/zijintaizhang(?:;|$)/);
  assert.equal((await f.request('/planner?date=2026-11-15', { session })).status, 200);
});
