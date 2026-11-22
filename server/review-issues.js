const descriptions = {
  MISSING_MONTH: ['计划月份不明确', '确认带年份的计划付款月份；谈判付款还需核对对应月份的支付金额。'],
  INVALID_ESTIMATED_DATE: ['预估时间无法识别', '确认预估时间为带年份的有效日期；若为公式，请在 Excel 中计算并保存后上传。'],
  PLAN_AMOUNT_MISMATCH: ['分月计划与申请金额不一致', '对照各月支付金额与 OA 申请付款金额，确认分月安排和申请总额。'],
  MISSING_PAYER: ['付款主体未填写', '确认该笔由哪个主体付款，并补充原表付款主体。'],
  BALANCE_MISMATCH: ['已付加剩余与申请金额不一致', '对照原表申请金额、已付金额和剩余金额，确认三项是否对应同一笔付款。'],
  STATUS_CONFLICT: ['结清标记与剩余金额矛盾', '确认该笔是否已结清，并核对原表结清标记和剩余金额。'],
  RULE_PAID_MISMATCH: ['付款依据与台账已付不一致', '对照原台账已付金额与批注或付款进度整理中的依据，确认哪项需要更新。'],
  ZERO_DEFAULTED: ['空金额按0处理', '已按约定计为0；如需补充金额，在 Excel 修改后重新上传。'],
  NEGATIVE_AMOUNT: ['负金额待确认', '确认负金额是否为退款或冲减，并核对金额及对应记录。'],
  PAYMENT_STATUS_UNCERTAIN: ['批注中的付款状态不明确', '核对提示单元格的付款日期、已付金额和状态，确认分期与计划月份的对应关系。'],
  PAYMENT_PROGRESS_REVIEW: ['付款状态待确认', '核对付款进度整理中的流程号、申请金额、供应商、付款主体及是否已付款。'],
  LEGACY_PAYMENT_PROGRESS_MISSING: ['历史文件缺少付款进度依据', '在付款节奏中补齐付款进度整理及提示的必需字段，核对后重新上传。'],
  APPLICATION_PARTIAL_REVIEW: ['申请金额需要核对', '核对该批申请日期或提交状态、金额及同批付款依据；在分期金额格批注或申请单状态字段中补全，不以 OA 号代替。'],
  DUPLICATE_FLOW: ['同流程号存在多笔记录', '对照关联位置，确认是同一流程的分笔记录还是重复登记；不要直接合并金额。'],
  POSSIBLE_DUPLICATE: ['金额和月份相近，疑似重叠', '对照关联位置的供应商、付款主体、金额和月份，确认是否为同一笔付款。'],
  MISSING_FILE: ['文件尚未上传', '在文件管理中确认并上传对应槽位的文件。'],
  INVALID_PAYMENT_PROGRESS: ['付款进度表内容需核对', '按原提示核对付款进度整理的工作表、必需字段或金额单元格。'],
  INVALID_SHEET: ['工作表或表头需核对', '确认所选工作表存在，并保留模板中的必需表头。'],
  MISSING_HEADER: ['必需表头缺失', '按原提示补齐对应表头后重新上传。'],
  INVALID_ROW: ['原表记录需核对', '按原提示核对对应行和单元格，补充或修正原表内容。'],
};

function progressDescription(message) {
  if (message.includes('缺少可用的“付款进度整理”')) return ['缺少付款进度依据', '确认付款节奏包含可用的付款进度整理及必需字段，补齐后重新上传。'];
  if (message.includes('没有有效流程号')) return ['无有效付款流程号', '确认该笔是否已申请付款；如已申请，补充有效付款 OA 号以关联付款进度。'];
  if (message.includes('未匹配流程号')) return ['付款进度未匹配流程号', '核对原表流程号，并确认付款进度整理中是否有该流程的记录。'];
  if (message.includes('流程号已找到，但申请金额')) return ['同流程号的付款信息不一致', '对照两张表的申请金额、供应商和付款主体，确认是否为同一笔付款。'];
  if (message.includes('相互冲突的付款状态')) return ['同笔付款状态冲突', '对照付款进度整理中同流程号的多条记录，确认实际付款状态。'];
  if (message.includes('仍对应多笔记录')) return ['付款进度仍对应多笔记录', '对照付款进度整理中同流程号、金额、供应商和主体，确认该笔对应哪条记录。'];
  if (message.includes('“是否已付款”为空')) return ['付款进度未填写状态', '核实该笔是否已付款，并补充付款进度整理中的状态。'];
  if (/“是否已付款”为“(?:未付款|未支付)”/.test(message)) return ['付款进度标记未付款', '确认是否仍未付款；如已完成支付，请更新付款进度整理中的状态。'];
  if (message.includes('“是否已付款”为“重新申请”')) return ['付款进度标记重新申请', '确认该笔重新申请的当前进度；完成付款后更新付款进度整理中的状态。'];
  return descriptions.PAYMENT_PROGRESS_REVIEW;
}

export function describeReviewIssue(issue, recordsByKey) {
  const [title, action] = issue.code === 'PAYMENT_PROGRESS_REVIEW' ? progressDescription(String(issue.message ?? ''))
    : Object.hasOwn(descriptions, issue.code) ? descriptions[issue.code]
      : [issue.message || '待核对事项', '对照来源文件确认该项内容。'];
  const record = recordsByKey.get(issue.recordKey);
  const relatedLocations = [...new Set(issue.relatedRecordKeys ?? [])].flatMap(key => {
    const related = recordsByKey.get(key);
    return related ? [{ filename: related.filename || '', sourceSheet: related.sourceSheet || '',
      sourceRow: related.sourceRow ?? null, supplier: related.supplier || '' }] : [];
  });
  return { ...issue, title, action, filename: issue.filename || record?.filename || '',
    sourceSheet: issue.sourceSheet ?? record?.sourceSheet ?? '', sourceRow: issue.sourceRow ?? record?.sourceRow ?? null,
    relatedLocations };
}
