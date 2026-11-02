# Put it on your own Cloudflare account

A free Cloudflare account is enough. You need Node 20 or newer. The commands run from the repo folder.

Check the current free limits on [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/) and [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) before you rely on them.

1. Sign in to Cloudflare from this folder.

   ```sh
   npx wrangler login
   ```

2. Make the database.

   ```sh
   npx wrangler d1 create onething
   ```

3. Paste the `database_id` it prints into `wrangler.jsonc`, in place of the zeros.

4. Set your name and time zone in `wrangler.jsonc`, under `vars`: `USER_NAME` and `TIMEZONE` (for example `Europe/Paris`).

5. Set four secrets. Each command asks you to paste a value. Use a long passphrase you can type on a phone for the first. For the other three, run `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"` once each and paste the output.

   ```sh
   npx wrangler secret put APP_PASSPHRASE
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put API_TOKEN
   npx wrangler secret put RUNNER_TOKEN
   ```

   `npx wrangler secret put` creates the Worker if it does not exist yet. Skip `RUNNER_TOKEN` if you will not run a runner: the app then picks with its own rules, and it says so.

6. Build, apply the schema and deploy.

   ```sh
   npm run deploy
   ```

7. Open the `workers.dev` address it prints on your phone, sign in with your passphrase, and use your browser's "Add to Home Screen".

If you rename the Worker, change `name` and the `SELF` service together in `wrangler.jsonc`. The job dispatcher calls the Worker through that binding.

## A model (pick one, or none)

- None: filing falls back to word rules.
- Workers AI, the default in `wrangler.jsonc`: the free allowance on your own account does the filing. Remove the `ai` block to turn it off.
- Your Anthropic API key: `npx wrangler secret put ANTHROPIC_API_KEY`. It takes priority over Workers AI, and Anthropic bills your account.

## Forwarded email

Without this the app never sees email. In the Cloudflare dashboard, go to your domain, then Email, then Email Routing, then Routes. Add an address and choose "Send to a Worker" and this Worker. You need a domain on Cloudflare for this step. Anyone who learns the address can put a to-do in your held queue, so treat it as semi-private. At most `email.daily_cap` (25) emails a day are kept.

## The runner

On your own machine, with the [official `claude` tool](https://code.claude.com/docs/en/overview) installed:

```sh
ONETHING_URL=https://your-worker.workers.dev ONETHING_RUNNER_TOKEN=... ANTHROPIC_API_KEY=... npm run runner
```

It runs one pass over the queue and exits. Read "Which Claude" in the README before you schedule it. On Windows PowerShell, set the three values with `$env:NAME = "value"` first.

## Claude Code

```sh
claude mcp add onething -e ONETHING_URL=https://your-worker.workers.dev -e ONETHING_API_TOKEN=... -- node /full/path/to/onething/tools/mcp/server.mjs
```

It gets three tools: `now`, `list_tasks`, `add_task`.
