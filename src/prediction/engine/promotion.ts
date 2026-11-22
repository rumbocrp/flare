/**
 * Promotion gate enforcement (`n >= 500`, Wilson LB >= break-even + 1.0pp,
 * positive net PnL, +30s markout >= -0.02, or audited operator force override)
 * and Canary Risk Budget controller ($5/trade, 3-4 UTC daily losses, $15 BTC cap).
 *
 * Browser-and-server-safe (zero Node-only or `src/server/*` imports).
 */
import type { PromotionReport } from '../replayHarness'
import type {
  CanaryBudgetDecision,
  CanaryOpenPosition,
  CanaryRiskConfig,
  PromotionTransitionResult,
  StrategyLifecycleMode,
} from './types'

const EPSILON = 1e-9

export const DEFAULT_CANARY_RISK_CONFIG: CanaryRiskConfig = {
  stakeUsd: 5,
  maxDailyLosses: 3,
  maxDailyLossUsd: 15,
  maxConcurrentBtcExposureUsd: 15,
}

export function normalizeCanaryRiskConfig(
  config?: Partial<CanaryRiskConfig>,
): CanaryRiskConfig {
  const stakeUsd =
    config?.stakeUsd !== undefined &&
    Number.isFinite(config.stakeUsd) &&
    config.stakeUsd > 0
      ? config.stakeUsd
      : DEFAULT_CANARY_RISK_CONFIG.stakeUsd

  const maxDailyLosses: 3 | 4 = config?.maxDailyLosses === 4 ? 4 : 3

  const maxDailyLossUsd =
    config?.maxDailyLossUsd !== undefined &&
    Number.isFinite(config.maxDailyLossUsd) &&
    config.maxDailyLossUsd > 0
      ? config.maxDailyLossUsd
      : maxDailyLosses * stakeUsd

  const maxConcurrentBtcExposureUsd =
    config?.maxConcurrentBtcExposureUsd !== undefined &&
    Number.isFinite(config.maxConcurrentBtcExposureUsd) &&
    config.maxConcurrentBtcExposureUsd > 0
      ? config.maxConcurrentBtcExposureUsd
      : DEFAULT_CANARY_RISK_CONFIG.maxConcurrentBtcExposureUsd

  return {
    stakeUsd,
    maxDailyLosses,
    maxDailyLossUsd,
    maxConcurrentBtcExposureUsd,
  }
}

export type PromotionTransitionOptions = {
  forceOverride?: boolean
  overrideReason?: string
}

/**
 * Validates lifecycle transitions (`disabled` / `research` / `paper` / `canary` / `scale`).
 * Transitions into live capital modes (`canary`, `scale`) enforce all out-of-sample
 * `PromotionReport` criteria unless an audited `forceOverride` with non-empty reason is supplied.
 */
export function evaluatePromotionTransition(
  fromMode: StrategyLifecycleMode,
  toMode: StrategyLifecycleMode,
  report: PromotionReport | null,
  options?: PromotionTransitionOptions,
): PromotionTransitionResult {
  const isLiveTarget = toMode === 'canary' || toMode === 'scale'

  if (!isLiveTarget) {
    const requiresAudit = toMode !== fromMode
    return {
      allowed: true,
      fromMode,
      toMode,
      forcedOverride: false,
      requiresAudit,
      failures: [],
      ...(requiresAudit
        ? {
            auditDetails: {
              action: 'prediction.strategy.mode_change',
              forcedOverride: false,
              settledWindowCount: report?.settledWindowCount ?? 0,
              wilsonLowerBoundPct: report?.wilsonLowerBoundPct ?? 0,
              avgBreakEvenPct: report?.avgBreakEvenPct ?? 0,
              netPnlUsd: report?.netPnlUsd ?? 0,
              meanMarkout30s: report?.meanMarkout30s ?? 0,
            },
          }
        : {}),
    }
  }

  const failures: string[] = []
  if (report === null) {
    failures.push(
      'Promotion to live canary/scale requires a completed out-of-sample PromotionReport',
    )
  } else {
    if (
      !Number.isFinite(report.settledWindowCount) ||
      report.settledWindowCount < 500
    ) {
      failures.push(
        `Minimum sample gate failed: ${String(report.settledWindowCount)} / 500 settled windows`,
      )
    }
    if (!Number.isFinite(report.tradeCount) || report.tradeCount <= 0) {
      failures.push('Promotion requires > 0 out-of-sample trades on test split')
    } else if (
      !Number.isFinite(report.wilsonLowerBoundPct) ||
      !Number.isFinite(report.avgBreakEvenPct) ||
      report.wilsonLowerBoundPct < report.avgBreakEvenPct + 1.0 - EPSILON
    ) {
      failures.push(
        `Wilson 95% LB (${String(report.wilsonLowerBoundPct)}%) below break-even + 1.0pp (${(report.avgBreakEvenPct + 1.0).toFixed(1)}%)`,
      )
    }
    if (!Number.isFinite(report.netPnlUsd) || report.netPnlUsd <= 0) {
      failures.push(
        `Out-of-sample net PnL must be positive ($${String(report.netPnlUsd)})`,
      )
    }
    if (
      !Number.isFinite(report.meanMarkout30s) ||
      report.meanMarkout30s < -0.02 - EPSILON
    ) {
      failures.push(
        `Mean +30s markout (${String(report.meanMarkout30s)}) below -0.02 floor`,
      )
    }
    if (!report.eligibleForCanary && failures.length === 0) {
      failures.push(
        ...(report.gateFailures.length > 0
          ? report.gateFailures
          : ['PromotionReport.eligibleForCanary is false']),
      )
    }
  }

  const auditBase = {
    action: 'prediction.strategy.promote' as const,
    settledWindowCount: report?.settledWindowCount ?? 0,
    wilsonLowerBoundPct: report?.wilsonLowerBoundPct ?? 0,
    avgBreakEvenPct: report?.avgBreakEvenPct ?? 0,
    netPnlUsd: report?.netPnlUsd ?? 0,
    meanMarkout30s: report?.meanMarkout30s ?? 0,
  }

  if (failures.length === 0) {
    return {
      allowed: true,
      fromMode,
      toMode,
      forcedOverride: false,
      requiresAudit: true,
      failures: [],
      auditDetails: {
        ...auditBase,
        forcedOverride: false,
      },
    }
  }

  if (options?.forceOverride) {
    const reason = options.overrideReason?.trim()
    if (!reason) {
      return {
        allowed: false,
        fromMode,
        toMode,
        forcedOverride: false,
        requiresAudit: false,
        failures: [
          ...failures,
          'Audited force override requires a non-empty overrideReason',
        ],
      }
    }

    return {
      allowed: true,
      fromMode,
      toMode,
      forcedOverride: true,
      requiresAudit: true,
      failures,
      auditDetails: {
        ...auditBase,
        forcedOverride: true,
        overrideReason: reason,
      },
    }
  }

  return {
    allowed: false,
    fromMode,
    toMode,
    forcedOverride: false,
    requiresAudit: false,
    failures,
  }
}

/**
 * Checks whether a proposed canary ticket satisfies:
 * 1. Per-trade stake cap ($5 default)
 * 2. UTC daily loss count circuit breaker (3-4 losses/day)
 * 3. UTC daily realized loss cap ($15-$20/day)
 * 4. Concurrent BTC single-factor open exposure cap ($15 across 5m+15m+1h)
 */
export function checkCanaryRiskBudget(
  openPositions: readonly CanaryOpenPosition[],
  todayLossesCount: number,
  todayLossUsd: number,
  config?: Partial<CanaryRiskConfig>,
  proposedStakeUsd?: number,
): CanaryBudgetDecision {
  const cfg = normalizeCanaryRiskConfig(config)
  const requestedStake = proposedStakeUsd ?? cfg.stakeUsd
  const reasons: string[] = []

  if (
    !Number.isFinite(requestedStake) ||
    requestedStake <= 0 ||
    requestedStake > cfg.stakeUsd + EPSILON
  ) {
    reasons.push(
      `Proposed stake $${String(requestedStake)} exceeds canary per-trade cap of $${cfg.stakeUsd}`,
    )
  }

  if (
    !Number.isFinite(todayLossesCount) ||
    todayLossesCount < 0 ||
    todayLossesCount >= cfg.maxDailyLosses
  ) {
    reasons.push(
      `UTC daily losing trades (${String(todayLossesCount)}) reached circuit breaker limit (${cfg.maxDailyLosses})`,
    )
  }

  if (
    !Number.isFinite(todayLossUsd) ||
    todayLossUsd < 0 ||
    todayLossUsd >= cfg.maxDailyLossUsd
  ) {
    reasons.push(
      `UTC daily realized loss ($${String(todayLossUsd)}) reached cap ($${cfg.maxDailyLossUsd})`,
    )
  }

  let openBtcExposureUsd = 0
  let invalidPositionFound = false
  for (const pos of openPositions) {
    const asset = (pos.asset ?? 'BTC').toUpperCase()
    if (asset !== 'BTC') continue
    if (!Number.isFinite(pos.stakeUsd) || pos.stakeUsd < 0) {
      invalidPositionFound = true
      continue
    }
    openBtcExposureUsd += pos.stakeUsd
  }

  if (invalidPositionFound) {
    reasons.push('Open BTC exposure contains invalid/non-finite stakeUsd (fail-closed)')
  }

  const remainingBtcExposureUsd = Math.max(
    0,
    cfg.maxConcurrentBtcExposureUsd - openBtcExposureUsd,
  )

  if (
    Number.isFinite(requestedStake) &&
    openBtcExposureUsd + requestedStake > cfg.maxConcurrentBtcExposureUsd + EPSILON
  ) {
    reasons.push(
      `Concurrent BTC exposure ($${openBtcExposureUsd.toFixed(2)} + $${requestedStake.toFixed(2)}) exceeds $${cfg.maxConcurrentBtcExposureUsd} cap across 5m+15m+1h`,
    )
  }

  const allowed = reasons.length === 0
  return {
    allowed,
    approvedStakeUsd: allowed ? requestedStake : 0,
    openBtcExposureUsd,
    remainingBtcExposureUsd,
    todayLossesCount,
    todayLossUsd,
    reasons,
  }
}
