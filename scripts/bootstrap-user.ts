// Enroll a pilot user. Modes:
//   npm run bootstrap-user                       -> login with AUTH_email/AUTH_pwd from .env
//   npm run bootstrap-user -- --otp 123456       -> same, with 2FA OTP
//   npm run bootstrap-user -- --code <authCode>  -> browser-login fallback (paste authorizationCode
//        from https://auth-220.sit.kkday.com/auth/be2/login?loginFlow=POPUP if REST login is CSRF-blocked)
// Prints the static bearer ONCE. It is stored only as a sha256 hash.
//
// TEMPORARILY DISABLED during the SQLite->PostgreSQL migration (Task 7): this script still opened
// the old transition SQLite file directly via openDb(), which Task 7 deletes (src/store/db.ts is
// gone). Task 9 restores this script against createPgDb(config.db) + the async IdentityStore/
// CredentialStore. Until then, running it is a deliberate hard failure rather than a silent
// against-the-wrong-database run.
throw new Error('temporarily disabled during PG migration — Task 9 restores this script')
