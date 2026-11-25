import type {
  RuntimeEventRecord,
  RuntimeEventSeverity,
  RuntimeEventType,
} from './store/types'

export type AlertChannelKind = 'telegram' | 'webhook'

export type AlertDeliveryResult = {
  channel: AlertChannelKind
  ok: boolean
  status?: number
  error?: string
}

export type AlertDispatcherStatus = {
  enabled: boolean
  channels: {
    webhookConfigured: boolean
    telegramConfigured: boolean
  }
  minSeverity: RuntimeEventSeverity
  cooldownMs: number
  sentCount: number
  failedCount: number
  suppressedCooldownCount: number
  lastSentAt: string | null
  lastError: string | null
}

const SEVERITY_RANK: Record<RuntimeEventSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
}

const DEFAULT_COOLDOWN_MS = 30_000
const DISPATCH_TIMEOUT_MS = 5_000

const cooldownByKey = new Map<string, number>()
let sentCount = 0
let failedCount = 0
let suppressedCooldownCount = 0
let lastSentAt: string | null = null
let lastError: string | null = null
let customFetchImpl: typeof fetch | null = null

export function setAlertFetchForTests(fetchImpl: typeof fetch | null): void {
  customFetchImpl = fetchImpl
}

export function resetAlertDispatcherForTests(): void {
  cooldownByKey.clear()
  sentCount = 0
  failedCount = 0
  suppressedCooldownCount = 0
  lastSentAt = null
  lastError = null
  customFetchImpl = null
}

function getMinSeverity(): RuntimeEventSeverity {
  const raw = process.env.FLARE_ALERT_MIN_SEVERITY?.trim().toLowerCase()
  if (raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'critical') {
    return raw
  }
  return 'error'
}

function getCooldownMs(): number {
  const raw = Number(process.env.FLARE_ALERT_COOLDOWN_MS)
  if (Number.isFinite(raw) && raw >= 0 && raw <= 3_600_000) {
    return Math.round(raw)
  }
  return DEFAULT_COOLDOWN_MS
}

function getWebhookUrl(): string | null {
  const raw = process.env.FLARE_ALERT_WEBHOOK_URL?.trim() ?? ''
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString()
    }
  } catch {
    // Ignore malformed webhook URL
  }
  return null
}

function getTelegramConfig(): { botToken: string; chatId: string } | null {
  const botToken = process.env.FLARE_TELEGRAM_BOT_TOKEN?.trim() ?? ''
  const chatId = process.env.FLARE_TELEGRAM_CHAT_ID?.trim() ?? ''
  if (botToken.length > 8 && chatId.length > 0) {
    return { botToken, chatId }
  }
  return null
}

/** Redacts secret-like tokens or hex keys so alerts can never leak credentials. */
export function sanitizeAlertText(input: string): string {
  return input
    .replace(/([A-Za-z0-9_-]{0,20}(?:key|secret|token|passphrase|password)[=:\s]+)[^\s,;'"&]+/gi, '$1[REDACTED]')
    .replace(/\b0x[a-fA-F0-9]{40,}\b/g, '0x[REDACTED]')
    .slice(0, 1_500)
}

export function shouldDispatchAlert(
  event: Pick<RuntimeEventRecord, 'type' | 'severity'>,
  force = false,
): boolean {
  if (force) return true
  if (event.severity === 'critical') return true
  return SEVERITY_RANK[event.severity] >= SEVERITY_RANK[getMinSeverity()]
}

export function getAlertDispatcherStatus(): AlertDispatcherStatus {
  const webhookConfigured = Boolean(getWebhookUrl())
  const telegramConfigured = Boolean(getTelegramConfig())
  return {
    enabled: webhookConfigured || telegramConfigured,
    channels: {
      webhookConfigured,
      telegramConfigured,
    },
    minSeverity: getMinSeverity(),
    cooldownMs: getCooldownMs(),
    sentCount,
    failedCount,
    suppressedCooldownCount,
    lastSentAt,
    lastError,
  }
}

function buildWebhookBody(
  webhookUrl: string,
  event: {
    tenantId: string
    type: RuntimeEventType
    severity: RuntimeEventSeverity
    source: string
    message: string
    timestamp: string
    correlationId?: string | null
  },
): Record<string, unknown> {
  const safeMessage = sanitizeAlertText(event.message)
  const headline = `[FLARE ${event.severity.toUpperCase()} · ${event.type}] ${safeMessage}`
  const lower = webhookUrl.toLowerCase()

  if (lower.includes('discord.com/api/webhooks') || lower.includes('discordapp.com/api/webhooks')) {
    const color =
      event.severity === 'critical' || event.severity === 'error'
        ? 0xd92d47
        : event.severity === 'warn'
          ? 0xf59e0b
          : 0x0ecb81
    return {
      content: headline,
      embeds: [
        {
          title: `FLARE · ${event.type}`,
          description: safeMessage,
          color,
          fields: [
            { name: 'Severity', value: event.severity.toUpperCase(), inline: true },
            { name: 'Source', value: event.source, inline: true },
            { name: 'Tenant', value: event.tenantId, inline: true },
            ...(event.correlationId
              ? [{ name: 'Correlation ID', value: event.correlationId, inline: false }]
              : []),
          ],
          timestamp: event.timestamp,
        },
      ],
    }
  }

  if (lower.includes('hooks.slack.com/')) {
    return {
      text: headline,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*FLARE ${event.severity.toUpperCase()}* · \`${event.type}\` (\`${event.source}\`)\n${safeMessage}`,
          },
        },
      ],
    }
  }

  return {
    service: 'flare',
    tenantId: event.tenantId,
    type: event.type,
    severity: event.severity,
    source: event.source,
    correlationId: event.correlationId ?? null,
    message: safeMessage,
    timestamp: event.timestamp,
  }
}

/**
 * Dispatches an alert to configured Telegram and/or Webhook destinations.
 * Never throws; enforces per-(tenant, type, severity) cooldown except for KILL_SWITCH and force=true.
 */
export async function dispatchRuntimeAlert(
  event: Pick<
    RuntimeEventRecord,
    'tenantId' | 'type' | 'severity' | 'source' | 'message' | 'timestamp' | 'correlationId'
  >,
  options?: { force?: boolean; nowMs?: number; fetchImpl?: typeof fetch },
): Promise<{ dispatched: boolean; suppressed: boolean; results: AlertDeliveryResult[] }> {
  const force = options?.force === true
  if (!shouldDispatchAlert(event, force)) {
    return { dispatched: false, suppressed: false, results: [] }
  }

  const webhookUrl = getWebhookUrl()
  const telegram = getTelegramConfig()
  if (!webhookUrl && !telegram) {
    return { dispatched: false, suppressed: false, results: [] }
  }

  const nowMs = options?.nowMs ?? Date.now()
  const cooldownMs = getCooldownMs()
  const isCritical = force || event.severity === 'critical'
  const dedupeKey = `${event.tenantId}:${event.type}:${event.severity}`
  if (!isCritical && cooldownMs > 0) {
    const prev = cooldownByKey.get(dedupeKey)
    if (prev !== undefined && nowMs - prev < cooldownMs) {
      suppressedCooldownCount += 1
      return { dispatched: false, suppressed: true, results: [] }
    }
  }
  cooldownByKey.set(dedupeKey, nowMs)

  const fetchFn = options?.fetchImpl ?? customFetchImpl ?? globalThis.fetch
  const tasks: Promise<AlertDeliveryResult>[] = []

  if (webhookUrl) {
    const body = buildWebhookBody(webhookUrl, event)
    tasks.push(
      fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      })
        .then((resp) => ({
          channel: 'webhook' as const,
          ok: resp.ok,
          status: resp.status,
          ...(resp.ok ? {} : { error: `HTTP ${resp.status}` }),
        }))
        .catch((err) => ({
          channel: 'webhook' as const,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })),
    )
  }

  if (telegram) {
    const safeMsg = sanitizeAlertText(event.message)
    const text = `[FLARE ${event.severity.toUpperCase()} · ${event.type}]\n${safeMsg}\nSource: ${event.source} | Tenant: ${event.tenantId}`
    tasks.push(
      fetchFn(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      })
        .then((resp) => ({
          channel: 'telegram' as const,
          ok: resp.ok,
          status: resp.status,
          ...(resp.ok ? {} : { error: `HTTP ${resp.status}` }),
        }))
        .catch((err) => ({
          channel: 'telegram' as const,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })),
    )
  }

  const results = await Promise.all(tasks)
  const anyOk = results.some((r) => r.ok)
  const failed = results.filter((r) => !r.ok)
  if (anyOk) {
    sentCount += 1
    lastSentAt = new Date(nowMs).toISOString()
  }
  if (failed.length > 0) {
    failedCount += failed.length
    lastError = failed.map((f) => `${f.channel}: ${f.error ?? 'failed'}`).join('; ')
  }

  return { dispatched: true, suppressed: false, results }
}
