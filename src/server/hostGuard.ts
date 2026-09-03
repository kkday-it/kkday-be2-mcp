import type { Request, Response, NextFunction, RequestHandler } from 'express'

export interface HostGuardOptions {
  allowedHosts?: string[]
}

/**
 * Parses the hostname out of a raw Host header value (e.g. '127.0.0.1:8787' -> '127.0.0.1', '[::1]:8787' -> '::1').
 */
export function extractHostname(rawHost: string): string {
  const trimmed = rawHost.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const closingBracket = trimmed.indexOf(']')
    if (closingBracket !== -1) {
      return trimmed.slice(1, closingBracket)
    }
  }
  const colonIdx = trimmed.indexOf(':')
  return colonIdx !== -1 ? trimmed.slice(0, colonIdx) : trimmed
}

/**
 * DNS-rebinding and Host header validation middleware.
 * Validates that incoming requests come from trusted hostnames (127.0.0.1, localhost, ::1, or configured allowed hosts).
 * /healthz is exempted. All other endpoints (/mcp, /confirm, /oauth, etc.) are protected.
 */
export function buildHostGuard(options: HostGuardOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Exempt /healthz health-check endpoint
    if (req.path === '/healthz') {
      next()
      return
    }

    const rawHost = req.headers.host
    if (!rawHost) {
      // Non-standard request without Host header (e.g. some internal tests); allow
      next()
      return
    }

    const customAllowed = options.allowedHosts ?? []
    const envAllowed = process.env.APP_ALLOWED_HOSTS
      ? process.env.APP_ALLOWED_HOSTS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : []

    const allowedItems = new Set([
      '127.0.0.1',
      'localhost',
      '::1',
      '[::1]',
      ...customAllowed.map(s => s.toLowerCase()),
      ...envAllowed,
    ])

    const normalizedRaw = rawHost.trim().toLowerCase()
    const hostname = extractHostname(rawHost)

    // Check if either full Host (e.g. with port) or bare hostname is allowed
    if (allowedItems.has(normalizedRaw) || allowedItems.has(hostname)) {
      next()
      return
    }

    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: `Forbidden: Host header '${rawHost}' is not allowed`,
      },
    })
  }
}
