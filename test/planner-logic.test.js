import test from 'node:test';
import assert from 'node:assert/strict';
import { today, shiftDate, weekStart, weekEnd, weekLabel, exerciseStats, parseEntries } from '../public/jihuaguanli/logic.js';

test('北京时间跨日、自然周跨月跨年和闰年边界', () => {
  assert.equal(today(new Date('2026-11-15T15:59:59Z')), '2026-11-15');
  assert.equal(today(new Date('2026-11-15T16:00:00Z')), '2026-11-16');
  assert.equal(weekStart('2026-11-15'), '2026-11-09');
  assert.equal(weekStart('2026-11-16'), '2026-11-16');
  assert.equal(weekEnd('2026-12-31'), '2027-01-03');
  assert.equal(weekStart('2027-01-01'), '2026-12-28');
  assert.equal(weekEnd('2026-11-30'), '2026-12-06');
  assert.equal(shiftDate('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDate('2026-02-28', 1), '2026-03-01');
  assert.equal(shiftDate('2027-01-01', -1), '2026-12-31');
  assert.equal(shiftDate('2026-11-15', 0), '2026-11-15');
  assert.equal(weekLabel('2027-01-01'), '2026年12月28日 — 2027年01月03日');
  for (const date of ['', '2026-02-29', '2026-13-01', '2026-11-31', '2026-1-1']) {
    assert.throws(() => shiftDate(date, 1), RangeError);
    assert.throws(() => weekStart(date), RangeError);
  }
  assert.throws(() => shiftDate('2026-11-15', 0.5), RangeError);
});

test('运动统计按打卡日期去重，连续自然周跨年且中断重置', () => {
  const records = ['2027-01-04', '2027-01-04', '2026-12-31', '2026-12-24'].map(date => ({ date, data: {} }));
  assert.deepEqual(exerciseStats(records, '2027-01-04'), { thisWeek: 1, total: 4, streak: 3 });
  assert.deepEqual(exerciseStats(records, '2027-01-11'), { thisWeek: 0, total: 4, streak: 3 });
  assert.deepEqual(exerciseStats(records, '2027-01-18'), { thisWeek: 0, total: 4, streak: 0 });
  assert.deepEqual(exerciseStats([], '2026-11-15'), { thisWeek: 0, total: 0, streak: 0 });
  assert.deepEqual(exerciseStats(null, '2026-11-15'), { thisWeek: 0, total: 0, streak: 0 });
  const invalid = [{ date: '2026-11-15', deleted: true }, { date: '' }, { date: '2026-02-30' }, null];
  assert.deepEqual(exerciseStats(invalid, '2026-11-15'), { thisWeek: 0, total: 0, streak: 0 });
  assert.deepEqual(exerciseStats([{ date: '2026-11-09' }, { date: '2026-10-26' }], '2026-11-15'), { thisWeek: 1, total: 2, streak: 1 });
});

test('识别按行、分号和编号拆分，保留原文、零值、emoji并去除完全重复', () => {
  assert.deepEqual(parseEntries('', '2026-11-15'), []);
  assert.deepEqual(parseEntries(null, '2026-11-15'), []);
  assert.equal(parseEntries(0, '2026-11-15')[0].title, '0');
  const entries = parseEntries('1. 今天完成报价 #工作\n2、明天读书 📖 #学习；3） 后天跑步 #运动 #运动\n\n今天完成报价 #工作\n- [ ] 0\n记录单价 1.5 元', '2026-11-15');
  assert.equal(entries.length, 5);
  assert.deepEqual(entries[0], { title: '今天完成报价 #工作', date: '2026-11-15', priority: '普通', tags: ['工作'], done: false });
  assert.equal(entries[1].title, '明天读书 📖 #学习');
  assert.equal(entries[1].date, '2026-11-16');
  assert.deepEqual(entries[2].tags, ['运动']);
  assert.equal(entries[2].date, '2026-11-17');
  assert.equal(entries[3].title, '0');
  assert.equal(entries[3].date, '');
  assert.equal(entries[4].title, '记录单价 1.5 元');
  assert.equal(entries[4].date, '');
  assert.deepEqual(parseEntries('一、整理资料 二、复盘', '2026-11-15').map(item => item.title), ['整理资料', '复盘']);
});

test('明确日期识别包含跨年相对日期；缺失、非法及冲突日期留空', () => {
  const dateOf = title => parseEntries(title, '2026-12-31')[0].date;
  assert.equal(dateOf('明天完成'), '2027-01-01');
  assert.equal(dateOf('后天完成'), '2027-01-02');
  assert.equal(dateOf('本周一完成'), '2026-12-28');
  assert.equal(dateOf('这周日完成'), '2027-01-03');
  assert.equal(dateOf('下周三完成'), '2027-01-06');
  assert.equal(dateOf('下星期天完成'), '2027-01-10');
  assert.equal(dateOf('2027年1月3日交付'), '2027-01-03');
  assert.equal(dateOf('2027-01-03交付'), '2027-01-03');
  assert.equal(dateOf('2027/1/3交付'), '2027-01-03');
  assert.equal(dateOf('12月30号交付'), '2026-12-30');
  assert.equal(dateOf('11/15交付'), '2026-11-15');
  assert.equal(dateOf('2026.12.31交付'), '2026-12-31');
  assert.equal(dateOf('2月29日交付'), '');
  assert.equal(dateOf('2026-13-01交付'), '');
  assert.equal(dateOf('31月1日交付'), '');
  assert.equal(dateOf('今天整理，明天完成'), '');
  assert.equal(dateOf('今天（2026-12-31）整理'), '2026-12-31');
  assert.equal(dateOf('整理资料'), '');
  assert.equal(dateOf('记录单价1.5元'), '');
  assert.equal(dateOf('交期3-5天'), '');
  assert.throws(() => parseEntries('今天整理', '2026-02-30'), RangeError);
});

test('优先级只取显式提示，否定紧急不误判；标签不改原文', () => {
  const priority = title => parseEntries(title, '2026-11-15')[0].priority;
  assert.equal(priority('紧急：发送报告'), '紧急');
  assert.equal(priority('重要但不紧急，读书'), '重要');
  assert.equal(priority('不是紧急任务，整理资料'), '普通');
  assert.equal(priority('不太紧急，无需加急'), '普通');
  assert.equal(priority('并非重要，无需优先'), '普通');
  assert.equal(priority('紧急程度不高'), '普通');
  assert.equal(priority('P0 处理异常'), '紧急');
  assert.equal(priority('P1 处理事项'), '重要');
  assert.equal(priority('普通事项'), '普通');
  const parsed = parseEntries('跑步 🏃 #运动🏃 #work_notes，#运动🏃', '2026-11-15')[0];
  assert.deepEqual(parsed.tags, ['运动🏃', 'work_notes']);
  assert.equal(parsed.title, '跑步 🏃 #运动🏃 #work_notes，#运动🏃');
});
