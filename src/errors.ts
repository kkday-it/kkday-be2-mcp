export class AppError extends Error {
  constructor(public code: string, message: string, public status = 500) { super(message) }
}
export class AuthError extends AppError {}
export class GatewayError extends AppError {}
export class RateError extends AppError {}
