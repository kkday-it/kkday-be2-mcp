import { NodeSDK } from '@opentelemetry/sdk-node'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

let sdk: NodeSDK | undefined

// Init once at process start, BEFORE any tracer use. In 'off' mode no SDK is started;
// the OpenTelemetry API's built-in no-op tracer is used instead, so span code paths
// stay identical — but traceId comes back all-zeros and audit rows carry no usable
// trace correlation.
export function initOtel(mode: 'console' | 'otlp' | 'off'): void {
  if (mode === 'off') return
  sdk = new NodeSDK({
    serviceName: 'be2-mcp',
    traceExporter: mode === 'otlp' ? new OTLPTraceExporter() : new ConsoleSpanExporter(),
  })
  sdk.start()
  // 關機協調統一由 index.ts 的 makeShutdown 主導（await shutdownOtel），此處不再自掛 SIGTERM。
}

export async function shutdownOtel(): Promise<void> {
  await sdk?.shutdown()
}
