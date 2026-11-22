/**
 * Authentication, Multi-Tenant Scoping, RBAC, Rate Limiting, and Strict CORS
 * enforcement (`P0-3`).
 *
 * Security model:
 * - Tokens are verified with SHA-256 + `crypto.timingSafeEqual` against
 *   `FLARE_API_TOKENS` (JSON array or comma-separated `token:tenantId:role[:subject]`)
 *   and dynamically registered tokens.
 * - Fail-closed when `NODE_ENV=production`, `FLARE_AUTH_REQUIRED=true`, or any
 *   API tokens are configured.
 * - Cross-tenant `X-Tenant-Id` mismatches are rejected with `403 Forbidden`.
 * - CORS never emits wildcard `*` in production; origins must match
 *   `FLARE_CORS_ORIGINS` (or loopback dev origins in non-production).
 */
import crypto from 'node:crypto'
import type http from 'node:http'
import {
  getSharedStateAdapter,
  type SharedStateAdapter,
} from './cache/sharedState'

export type Role = 'viewer' | 'researcher' | 'trader' | 'risk_manager' | 'admin'

export type Permission =
  | 'read:health'
  | 'read:state'
  | 'run:research'
  | 'trade:execute'
  | 'risk:engage_killswitch'
  | 'risk:manage'
  | 'ledger:read'
  | 'audit:read'
  | 'admin:manage'

export type AuthPrincipal = {
  subject: string
  tenantId: string
  role: Role
  authMode: 'token' | 'dev-bypass'
  tokenId?: string
}

export type TokenRegistration = {
  token: string
  tenantId: string
  role: Role
  subject?: string
  tokenId?: string
}

export type AuthResult =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; status: 401 | 403; error: string }

export type RateLimitBucket = 'read' | 'write'

export type RateLimitResult = {
  allowed: boolean
  limit: number
  remaining: number
  resetAtMs: number
  retryAfterSec: number
}

export type CorsResolution = {
  allowed: boolean
  origin: string | null
  headers: Record<string, string>
}

const VALID_ROLES = new Set<Role>([
  'viewer',
  'researcher',
  'trader',
  'risk_manager',
  'admin',
])

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set<Permission>(['read:health', 'read:state']),
  researcher: new Set<Permission>([
    'read:health',
    'read:state',
    'run:research',
  ]),
  trader: new Set<Permission>([
    'read:health',
    'read:state',
    'run:research',
    'trade:execute',
    'risk:engage_killswitch',
    'ledger:read',
  ]),
  risk_manager: new Set<Permission>([
    'read:health',
    'read:state',
    'run:research',
    'trade:execute',
    'risk:engage_killswitch',
    'risk:manage',
    'ledger:read',
    'audit:read',
  ]),
  admin: new Set<Permission>([
    'read:health',
    'read:state',
    'run:research',
    'trade:execute',
    'risk:engage_killswitch',
    'risk:manage',
    'ledger:read',
    'audit:read',
    'admin:manage',
  ]),
}

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
]

const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

type HashedTokenRecord = {
  tokenHash: Buffer
  tokenId: string
  tenantId: string
  role: Role
  subject: string
}

const runtimeTokenRegistry: HashedTokenRecord[] = []

function sha256Buffer(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest()
}

export function sanitizeTenantId(raw: string): string {
  const trimmed = raw.trim()
  if (!TENANT_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid tenantId "${raw}". Must match ${TENANT_ID_PATTERN.source}.`,
    )
  }
  return trimmed
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false
}

export function registerApiToken(reg: TokenRegistration): void {
  const token = reg.token.trim()
  if (token.length < 8) {
    throw new Error('API tokens must be at least 8 characters long.')
  }
  if (!VALID_ROLES.has(reg.role)) {
    throw new Error(`Unsupported RBAC role: ${String(reg.role)}`)
  }
  const tenantId = sanitizeTenantId(reg.tenantId)
  const tokenHash = sha256Buffer(token)
  const tokenId = reg.tokenId ?? tokenHash.subarray(0, 6).toString('hex')
  const subject = reg.subject?.trim() || `${tenantId}:${reg.role}`

  const existingIdx = runtimeTokenRegistry.findIndex((r) =>
    crypto.timingSafeEqual(r.tokenHash, tokenHash),
  )
  const record: HashedTokenRecord = {
    tokenHash,
    tokenId,
    tenantId,
    role: reg.role,
    subject,
  }
  if (existingIdx >= 0) {
    runtimeTokenRegistry[existingIdx] = record
  } else {
    runtimeTokenRegistry.push(record)
  }
}

export function clearRegisteredApiTokens(): void {
  runtimeTokenRegistry.length = 0
}

function parseEnvTokens(): HashedTokenRecord[] {
  const raw = process.env.FLARE_API_TOKENS?.trim()
  if (!raw) return []
  const records: HashedTokenRecord[] = []

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as Partial<TokenRegistration>[]
      for (const item of parsed) {
        if (
          typeof item.token === 'string' &&
          item.token.trim().length >= 8 &&
          typeof item.tenantId === 'string' &&
          TENANT_ID_PATTERN.test(item.tenantId.trim()) &&
          item.role &&
          VALID_ROLES.has(item.role)
        ) {
          const hash = sha256Buffer(item.token.trim())
          records.push({
            tokenHash: hash,
            tokenId: item.tokenId ?? hash.subarray(0, 6).toString('hex'),
            tenantId: item.tenantId.trim(),
            role: item.role,
            subject:
              item.subject?.trim() || `${item.tenantId.trim()}:${item.role}`,
          })
        }
      }
      return records
    } catch {
      return []
    }
  }

  for (const entry of raw.split(',')) {
    const parts = entry
      .trim()
      .split(':')
      .map((p) => p.trim())
    if (parts.length < 3) continue
    const [token, tenantId, roleRaw, subjectRaw] = parts
    const role = roleRaw as Role
    if (
      token.length >= 8 &&
      TENANT_ID_PATTERN.test(tenantId) &&
      VALID_ROLES.has(role)
    ) {
      const hash = sha256Buffer(token)
      records.push({
        tokenHash: hash,
        tokenId: hash.subarray(0, 6).toString('hex'),
        tenantId,
        role,
        subject: subjectRaw || `${tenantId}:${role}`,
      })
    }
  }
  return records
}

function getAllTokenRecords(): HashedTokenRecord[] {
  return [...parseEnvTokens(), ...runtimeTokenRegistry]
}

export function isAuthEnforced(): boolean {
  if (process.env.NODE_ENV === 'production') return true
  if (process.env.FLARE_AUTH_REQUIRED === 'true') return true
  if (process.env.FLARE_AUTH_REQUIRED === 'false') return false
  return getAllTokenRecords().length > 0
}

function readHeaderString(
  req: http.IncomingMessage,
  name: string,
): string | null {
  const val = req.headers?.[name.toLowerCase()]
  if (typeof val === 'string') return val.trim() || null
  if (Array.isArray(val) && val.length > 0) return val[0]?.trim() || null
  return null
}

export function extractBearerToken(
  req: http.IncomingMessage,
  url?: URL,
): string | null {
  const authHeader = readHeaderString(req, 'authorization')
  if (authHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader)
    if (match?.[1]) return match[1].trim()
  }

  const apiKey = readHeaderString(req, 'x-api-key')
  if (apiKey) return apiKey

  const queryToken = url?.searchParams.get('token')?.trim()
  if (queryToken) return queryToken

  return null
}

function verifyToken(token: string): HashedTokenRecord | null {
  const candidateHash = sha256Buffer(token)
  const records = getAllTokenRecords()
  for (const rec of records) {
    if (
      rec.tokenHash.length === candidateHash.length &&
      crypto.timingSafeEqual(rec.tokenHash, candidateHash)
    ) {
      return rec
    }
  }
  return null
}

export function authenticateRequest(
  req: http.IncomingMessage,
  url?: URL,
): AuthResult {
  const requestedTenantHeader = readHeaderString(req, 'x-tenant-id')
  const token = extractBearerToken(req, url)

  if (token) {
    const matched = verifyToken(token)
    if (!matched) {
      return {
        ok: false,
        status: 401,
        error: 'Invalid or expired API credentials.',
      }
    }
    if (
      requestedTenantHeader &&
      requestedTenantHeader !== matched.tenantId
    ) {
      return {
        ok: false,
        status: 403,
        error: `Cross-tenant access denied for tenant "${requestedTenantHeader}".`,
      }
    }
    return {
      ok: true,
      principal: {
        subject: matched.subject,
        tenantId: matched.tenantId,
        role: matched.role,
        authMode: 'token',
        tokenId: matched.tokenId,
      },
    }
  }

  if (isAuthEnforced()) {
    return {
      ok: false,
      status: 401,
      error:
        'Authentication required. Provide Authorization: Bearer <token> or X-API-Key.',
    }
  }

  const devTenant =
    requestedTenantHeader && TENANT_ID_PATTERN.test(requestedTenantHeader)
      ? requestedTenantHeader
      : 'default'

  return {
    ok: true,
    principal: {
      subject: `local-dev:${devTenant}`,
      tenantId: devTenant,
      role: 'admin',
      authMode: 'dev-bypass',
    },
  }
}

export function authorizePermission(
  principal: AuthPrincipal,
  permission: Permission,
): { ok: true } | { ok: false; status: 403; error: string } {
  if (hasPermission(principal.role, permission)) {
    return { ok: true }
  }
  return {
    ok: false,
    status: 403,
    error: `Forbidden: role "${principal.role}" lacks "${permission}" permission.`,
  }
}

export function getAllowedCorsOrigins(): string[] {
  const configured = process.env.FLARE_CORS_ORIGINS?.trim()
  if (configured) {
    return configured
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0 && o !== '*')
  }
  if (process.env.NODE_ENV === 'production') {
    return []
  }
  return DEFAULT_DEV_ORIGINS
}

export function resolveCorsHeaders(req: http.IncomingMessage): CorsResolution {
  const origin = readHeaderString(req, 'origin')
  const baseHeaders: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-API-Key, X-Tenant-Id',
    'Access-Control-Max-Age': '600',
  }

  if (!origin) {
    return { allowed: true, origin: null, headers: baseHeaders }
  }

  const allowlist = getAllowedCorsOrigins()
  const isAllowed = allowlist.includes(origin)

  if (!isAllowed) {
    return {
      allowed: false,
      origin,
      headers: { Vary: 'Origin' },
    }
  }

  return {
    allowed: true,
    origin,
    headers: {
      ...baseHeaders,
      'Access-Control-Allow-Origin': origin,
    },
  }
}

function resolveClientAddress(req: http.IncomingMessage): string {
  const forwarded = readHeaderString(req, 'x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() || 'unknown'
  }
  return req.socket?.remoteAddress || 'local'
}

export async function checkRateLimit(
  req: http.IncomingMessage,
  principal: AuthPrincipal | null,
  bucket: RateLimitBucket,
  adapter: SharedStateAdapter = getSharedStateAdapter(),
): Promise<RateLimitResult> {
  const defaultReadRpm = 240
  const defaultWriteRpm = 60
  const envVal =
    bucket === 'write'
      ? Number(process.env.FLARE_RATE_LIMIT_WRITE_RPM)
      : Number(process.env.FLARE_RATE_LIMIT_READ_RPM)
  const limit =
    Number.isFinite(envVal) && envVal > 0
      ? Math.round(envVal)
      : bucket === 'write'
        ? defaultWriteRpm
        : defaultReadRpm

  const windowMs = 60_000
  const identity = principal
    ? `${principal.tenantId}:${principal.subject}`
    : `ip:${resolveClientAddress(req)}`
  const key = `${bucket}:${identity}`

  const { count, resetAtMs } = await adapter.incrWindow(key, windowMs)
  const remaining = Math.max(0, limit - count)
  const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000))

  return {
    allowed: count <= limit,
    limit,
    remaining,
    resetAtMs,
    retryAfterSec,
  }
}
