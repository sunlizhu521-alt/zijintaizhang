import test from 'node:test';
import assert from 'node:assert/strict';
import { money, moneyInWan } from '../src/format.js';

test('元保留精确分值，万元直接截取两位小数不四舍五入', () => {
  assert.equal(money(1_234_567_890), '12,345,678.90');
  assert.equal(moneyInWan(1_234_567_890), '1,234.56');
  assert.equal(moneyInWan(89_996_800), '89.99');
  assert.equal(money(89_996_800), '899,968.00');
  assert.equal(moneyInWan('89996800'), '89.99');
  assert.equal(moneyInWan(-89_996_800), '-89.99');
  assert.equal(moneyInWan(999_999), '0.99');
  assert.equal(moneyInWan(1_000_000), '1.00');
  assert.equal(moneyInWan(9_999), '0.00');
  assert.equal(moneyInWan(10_000), '0.01');
  assert.equal(moneyInWan(1), '0.00');
  assert.equal(money(1), '0.01');
  assert.equal(moneyInWan(0), '—');
  assert.equal(moneyInWan(-1_234_567), '-1.23');
  for (const value of [null, undefined, NaN, Infinity, '金额无效']) {
    assert.equal(moneyInWan(value), '待核对');
  }
});
