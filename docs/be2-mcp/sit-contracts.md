# SIT be2-220 — auth-service contract findings

> Captured from a live probe run against SIT `be2-220` (2026-08-09) using
> `scripts/probe-sit.ts` + `.env` credentials. Supersedes the guessed
> `{data}` / `{error:{code,message}}` envelope assumed in Task 3. Full
> fixture capture (product/inventory endpoints) is deferred to Task 16 —
> see §5.

## 1. Network

- `AUTHSVC_URL` and `GATEWAY_URL` hosts (`auth-220.sit.kkday.com`,
  `api-gateway-220.sit.kkday.com`) are reachable: requests return HTTP
  responses, not connection-refused.

## 2. Headless REST login is not CSRF-blocked

- `POST {AUTHSVC_URL}/api/v1/auth/be2/login` with a plain JSON body
  `{account, password}` and `content-type: application/json` reaches
  credential validation — it returns a business error, not a 419 / CSRF /
  HTML page.
- Consequence: the plan's ambiguity #3 ("does headless JSON login work, or
  do we need the `--code` browser fallback?") is resolved — headless JSON
  login works. The `--code` fallback can remain as an optional bootstrap
  path but is not required.

## 3. Response envelope

auth-service responses use a `{metadata, data}` envelope — **not** the
guessed `{data:...}` (bare) or `{error:{code,message}}` shape. Observed on
the error path (login rejection):

```json
{
  "metadata": {
    "status": "AU9010",
    "desc": "Incorrect username or password. ...",
    "pagination": null,
    "errors": null
  },
  "data": null
}
```

Field locations:

| Concern | Location |
|---|---|
| Error code | `body.metadata.status` (string, e.g. `"AU9010"`) |
| Error message | `body.metadata.desc` |
| Payload | `body.data` (object on success, `null` on error) |

`src/auth/authServiceClient.ts` reads `metadata.status` / `metadata.desc`
for error mapping, falling back to the legacy `body.error.{code,message}`
shape and then `HTTP_{status}` + a generic message when neither is
present.

### Success-payload key casing — UNVERIFIED, pending Task 16

Whether success payloads use camelCase (`authorizationCode`,
`accessToken`, `refreshToken`, `businessList`) or snake_case
(`authorization_code`, `access_token`, `refresh_token`, `business_list`)
could **not** be confirmed — the probe's login attempt was rejected at the
credential-check step (see §5) before a success response was ever
returned. `authServiceClient.ts` is deliberately tolerant of both casings
for `login`/`exchangeCode`/`refresh` until a real success response is
captured in Task 16 and this can be marked verified.

## 4. HTTP status on error

- The credential-rejection response came back as **HTTP 422** (Laravel
  validation-style), still carrying the full `{metadata, data}` envelope
  above — not a bare `{message}` or empty body.
- Consequence: error mapping must always attempt to read
  `metadata.status` / `metadata.desc` regardless of HTTP status code, and
  only fall back to `HTTP_{status}` + generic text when `metadata` is
  absent from the body.

## 5. Credentials blocker (not fixable in code)

- `.env` `AUTH_email` / `AUTH_pwd` are rejected by auth-service with
  `AU9010 Incorrect username or password` — a **pre-2FA** credential
  check (a 2FA failure would instead surface as `AU9011`).
- The account/password in `.env` is stale or wrong; this is an
  operational/credentials issue, not a code defect.
- Consequence: live fixture capture for the product/inventory endpoints
  (package-configs, inventory, switch, etc.) and confirmation of the
  success-payload key casing are **deferred to Task 16** (live e2e
  verification), once the user supplies valid SIT `be2-220` credentials.
  Tasks 5–15 do not depend on these fixtures — fixture-backed tests in
  Tasks 8–10 are written as `describe.skipIf(!existsSync(...))`.
