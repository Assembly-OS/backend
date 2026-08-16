# Backend runtime

The production image listens on port `3000`, runs as UID/GID `10001`, and
expects `/data` to be persistent. It is the only service allowed to initialize
or migrate `assambleya.db`.

Required runtime values are `AUTH_SECRET` (at least 32 characters),
`ADMIN_PASSWORD_HASH`, `ADMIN_LOGIN`, and `BOT_NOTIFY_SECRET`. Optional values
include `ANTHROPIC_API_KEY`, `CRM_ADMIN_LOGINS`, and `NEXT_PUBLIC_TIME_ZONE`.
The dev API remains unavailable in production unless `DEV_PANEL_ENABLED=1`
and the same unique `DEV_PANEL_KEY` of at least 32 bytes is supplied to backend
and frontend.

Generate a random secret with `npm run secret:generate`. Generate the admin
hash without placing the password on the command line by setting
`ADMIN_PASSWORD` in the local process environment and running
`npm run admin:hash`; save only the printed hash.

The local Whisper model and VAD model are mounted read-only at `/models`. The
image contains pinned `whisper-cli` and ffmpeg binaries, but never embeds model
weights or application data.
