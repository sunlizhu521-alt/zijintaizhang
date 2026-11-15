const DAY = 86400000;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function today(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

export function shiftDate(date, days) {
  if (!validDate(date) || !Number.isInteger(days)) throw new RangeError('日期或天数无效');
  const result = new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
  if (!validDate(result)) throw new RangeError('日期超出范围');
  return result;
}

export function weekStart(date) {
  if (!validDate(date)) throw new RangeError('日期无效');
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return shiftDate(date, -(weekday + 6) % 7);
}

export function weekEnd(date) { return shiftDate(weekStart(date), 6); }

export function weekLabel(date) {
  const label = value => value.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1年$2月$3日');
  return `${label(weekStart(date))} — ${label(weekEnd(date))}`;
}

export function exerciseStats(items, date = today()) {
  const start = weekStart(date);
  const end = weekEnd(date);
  const records = (Array.isArray(items) ? items : []).filter(item => item && !item.deleted && validDate(item.date));
  const days = new Set(records.map(item => item.date));
  const weeks = new Set([...days].map(weekStart));
  let cursor = weeks.has(start) ? start : shiftDate(start, -7);
  let streak = 0;
  while (weeks.has(cursor)) { streak++; cursor = shiftDate(cursor, -7); }
  return { thisWeek: [...days].filter(day => day >= start && day <= end).length, total: records.length, streak };
}

function readDate(title, baseDate) {
  // Ambiguous or invalid dates stay in the source text for the user to correct.
  const candidates = [];
  const absolute = /(?<!\d)(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日|号)?(?!\d)|(?<![\d./-])(\d{1,2})[月/-](\d{1,2})(?:日|号)?(?!\d|元|天|个|件|吨|%|％)/g;
  for (const match of title.matchAll(absolute)) {
    const value = `${match[1] || baseDate.slice(0, 4)}-${(match[2] || match[4]).padStart(2, '0')}-${(match[3] || match[5]).padStart(2, '0')}`;
    if (!validDate(value)) return '';
    candidates.push(value);
  }
  const offsets = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2 };
  for (const match of title.matchAll(/今天|今日|明天|明日|后天/g)) candidates.push(shiftDate(baseDate, offsets[match[0]]));
  for (const match of title.matchAll(/(本|这|下)(?:周|星期)([一二三四五六日天1-7])/g)) {
    const weekday = '一二三四五六日'.indexOf(match[2]);
    const offset = match[2] === '天' ? 6 : weekday >= 0 ? weekday : Number(match[2]) - 1;
    candidates.push(shiftDate(weekStart(baseDate), offset + (match[1] === '下' ? 7 : 0)));
  }
  const distinct = [...new Set(candidates)];
  return distinct.length === 1 ? distinct[0] : '';
}

function readPriority(title) {
  const positive = title
    .replace(/(?:不是|并非|不算|无需|无须|不用|非|不)\s*(?:很|特别|太)?\s*(?:紧急|加急|急办|重要|优先|着急)/g, '')
    .replace(/紧急(?:程度)?(?:不高|较低)|重要(?:程度)?(?:不高|较低)/g, '');
  if (/紧急|加急|急办|高优先级|\bP0\b/i.test(positive)) return '紧急';
  if (/重要|优先|\bP1\b/i.test(positive)) return '重要';
  return '普通';
}

export function parseEntries(text, baseDate = today()) {
  if (!validDate(baseDate)) throw new RangeError('参考日期无效');
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[；;]/g, '\n')
    .replace(/(?:^|[ \t]+)(?:\d{1,3}|[一二三四五六七八九十]+)[、.)）](?=\s|[^\d\s])/gm, '\n')
    .split('\n').map(line => line.replace(/^\s*[-*•]\s+(?:\[[ xX]\]\s*)?/, '').trim()).filter(Boolean);
  return [...new Set(lines)].map(title => ({
    title,
    date: readDate(title, baseDate),
    priority: readPriority(title),
    tags: [...new Set([...title.matchAll(/#([^\s#，。；;、！？!?：:,()（）[\]{}]+)/gu)].map(match => match[1]))],
    done: false,
  }));
}
