import { NodeSDK } from '@opentelemetry/sdk-node'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

// Init once at process start, BEFORE any tracer use. 'off' still registers the API
// (no-op tracer) so span code paths stay identical.
export function initOtel(mode: 'console' | 'otlp' | 'off'): void {
  if (mode === 'off') return
  const sdk = new NodeSDK({
    serviceName: 'be2-mcp',
    traceExporter: mode === 'otlp' ? new OTLPTraceExporter() : new ConsoleSpanExporter(),
  })
  sdk.start()
  process.on('SIGTERM', () => { void sdk.shutdown() })
}
