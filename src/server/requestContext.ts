import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestContext { bearer: string; sessionId: string; clientInfo: string }

export const requestContext = new AsyncLocalStorage<RequestContext>()
