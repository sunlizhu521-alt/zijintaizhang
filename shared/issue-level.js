export function isInformationIssue(issue) {
  return issue.code === 'ZERO_DEFAULTED' || (issue.code === 'PAYMENT_PROGRESS_REVIEW' &&
    /^“付款进度整理”的“是否已付款”为“(?:未付款|未支付|重新申请)”，计未付。$/.test(issue.message || ''));
}

export const reviewIssueCount = issues => issues.filter(issue => !isInformationIssue(issue)).length;
