# Hosting for iPhone access

No deployment or trading wallet was configured during this repair.

## Render

1. Put the contents of this ZIP in a private repository. Never commit .env, secrets, journal, or live state. A .gitignore is included.
2. Create a Render Blueprint from that repository. Review render.yaml: it specifies a PAID starter web service and a 1 GB persistent disk. Review current charges before deployment.
3. Enter your Helius key in Render secret environment settings. The blueprint generates a dashboard token. Keep DRY_RUN=true; no private key is needed for paper mode.
4. The disk mounts at /var/data. ENGINE_STATE_FILE and LOG_FILE point there. STATE_FILE also points there so an old state.json placed there is detected before migration.
5. Deploy exactly one instance, check its logs and /health, then open the service HTTPS address in Safari. Enter the dashboard token from Render settings. Add the page to the Home Screen.
6. After paper/route verification, to switch live set PRIVATE_KEY and DRY_RUN=false AND change ENGINE_STATE_FILE from /var/data/engine-paper.json to /var/data/engine-live.json. The bot refuses mixed-mode state.

For an existing service, preserve its state and reconcile old holdings/pending signatures before switching. Stop its previous instance. The blueprint is a deployment configuration, not proof of a completed deployment.

Render requires a paid service for persistent disks. Ordinary local changes are lost on restart/redeploy. Reference: https://render.com/docs/disks

## Other servers

Use Node.js 22+, one supervised process, HTTPS, and durable writable storage for ENGINE_STATE_FILE/LOG_FILE. Set DASHBOARD_HOST=0.0.0.0 behind the HTTPS proxy and supply a strong DASHBOARD_TOKEN. Wallet secrets stay on the server. A static host or browser tab cannot run this continuous Node process.
