// Studio 的免费规格与最终扣费不同：调度、参考附加费及额度由服务器决定。
const remaining = value => value === null ? '不限额' : Number.isFinite(value) ? String(Math.max(0, value)) : '待确认';
const quotaText = quota => `今日 ${remaining(quota?.daily_remaining)} · 本期 ${remaining(quota?.monthly_remaining)}`;

export function describeStudioUsage(snapshot, params) {
  const v5 = /^nai-diffusion-5-/.test(params.model || '');
  const quota = snapshot?.quota;
  const v5Allowed = snapshot?.permissions?.can_use_nai_v5_generation;
  const selected = v5 ? quota?.v5_tasks : quota?.tasks;
  const daily = selected?.daily_remaining;
  const period = selected?.monthly_remaining;
  // 服务端 V5 remaining 已包含贡献额度，不能再次相加；本期限制也不能被今日余额遮蔽。
  const known = [daily, period].every(value => value === null || Number.isFinite(value));
  const available = known ? Math.max(0, Math.min(daily ?? Infinity, period ?? Infinity)) : null;
  const overflow = v5 ? selected?.overflow : null;
  const resetAt = Date.parse(overflow?.resets_at);
  const extra = Number.isFinite(overflow?.daily_remaining) ? Math.max(0, overflow.daily_remaining) : 0;
  const extraStale = Number.isFinite(resetAt) && Date.now() >= resetAt;
  let quotaLabel = !known ? '额度待刷新'
    : available === Infinity ? '不限额'
      : available === 0 ? '个人额度已用完'
        : `${period !== null && period < (daily ?? Infinity) ? '本期' : '今日'}剩余 ${available} 张`;
  if (known && available === 0 && extra > 0) {
    quotaLabel = extraStale ? '额外额度待刷新' : `额外剩余 ${extra} 张`;
  }
  if (v5 && v5Allowed !== true) quotaLabel = v5Allowed === false ? 'V5 未开通' : 'V5 权限待确认';
  const pixels = Number(params.width) * Number(params.height);
  const steps = Number(params.steps);
  const valid = pixels > 0 && Number.isFinite(pixels) && steps > 0 && Number.isFinite(steps);
  // 与 Studio creation_policy 的免费规格边界一致；不是对最终 Anlas 消耗的报价。
  const free = valid && pixels <= 1024 * 1024 && steps <= 28;
  // 与实际请求一致：V5 不发送参考，精准参考优先，V4 Vibe 最多发送 4 项。
  const preciseSupported = ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'].includes(params.model);
  const preciseCount = preciseSupported ? Math.min(12, params.director_reference_images_cached?.length || 0) : 0;
  const v4 = /^nai-diffusion-4/.test(params.model || '');
  const vibeCount = v5 || preciseCount ? 0 : v4
    ? (params.vibeTransfer?.use_v4_vibe ? Math.min(4, params.vibeTransfer.reference_image_multiple?.length || 0) : 0)
    : params.vibeTransfer?.images?.length || 0;
  const preciseCost = preciseCount * 5;
  const vibeCost = Math.max(0, vibeCount - 4) * 2;
  // 镜像 Studio preview_user_anlas_billing / estimate_anlas_cost 的个人账本预估，
  // 不套用官方直连订阅、SMEA 或图生图强度公式；V5 显式付费回退需服务器决定。
  const roundedBase = Math.ceil(2.951823174884865e-6 * pixels + 5.753298233447344e-7 * pixels * steps);
  const baseCost = free ? 0 : Math.max(2, v5 ? Math.ceil(roundedBase * 1.5) : roundedBase);
  const count = Math.max(1, Math.trunc(Number(params.batchSize)) || 1);
  const uncertain = !valid || (v5 && params.allow_v5_anlas_fallback === true);
  const perImage = uncertain ? null : baseCost + preciseCost + vibeCost;
  const total = perImage === null ? null : perImage * count;
  const costLabel = uncertain ? '费用待确认' : perImage === 0 ? '免费 · 0 Anlas'
    : count > 1 ? `预计 ${perImage} Anlas/张 · 本批 ${total}` : `预计 ${perImage} Anlas`;
  const parts = [`基础 ${baseCost}`];
  if (preciseCost) parts.push(`精准参考 ${preciseCount} 项 +${preciseCost}`);
  if (vibeCost) parts.push(`Vibe 超出 ${vibeCount - 4} 项 +${vibeCost}`);
  const costHelp = uncertain ? '费用需 Studio 确认。' : perImage === 0
    ? '0 Anlas；仍计任务额度。'
    : `${parts.join('；')} Anlas/张；以结算为准。`;
  return { quotaLabel, costLabel, costHelp, perImage, total, count,
    quotaHelp: `个人任务：${quotaText(quota?.tasks)}；个人 Anlas：${quotaText(quota?.anlas)}；V5：${v5Allowed === false ? '未开通' : quotaText(quota?.v5_tasks)}。${overflow ? `额外名额：${extraStale ? '待刷新' : remaining(overflow.daily_remaining)}，能否使用取决于 Studio 当前调度状态。` : ''}点击查看额度详情。` };
}
