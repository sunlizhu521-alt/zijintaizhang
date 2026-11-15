import test from 'node:test';
import assert from 'node:assert/strict';
import { money, moneyInWan } from '../src/format.js';

test('图表从分分别换算元与万元，保留两位小数', () => {
  assert.equal(money(1_234_567_890), '12,345,678.90');
  assert.equal(moneyInWan(1_234_567_890), '1,234.57');
  assert.equal(moneyInWan(999_999), '1.00');
  assert.equal(moneyInWan(1), '0.00');
  assert.equal(money(1), '0.01');
  assert.equal(moneyInWan(0), '0.00');
  assert.equal(moneyInWan(-1_234_567), '-1.23');
  for (const value of [null, undefined, NaN, Infinity, '金额无效']) {
    assert.equal(moneyInWan(value), '未提供');
  }
});
