# Threat model

A planner that reads your email and talks to a model has one main risk: text someone else wrote gets treated as orders. This file says what stands in the way, and what does not.

## Who can do what

| Holder | Can | Cannot |
| --- | --- | --- |
| You, signed in | Everything in the app | |
| API token (`API_TOKEN`, used by the MCP server) | Read Now, read the list, add a to-do | Finish, change or delete anything; see a held email; approve a hold; read the runner's queue |
| Runner token (`RUNNER_TOKEN`) | List, claim and answer queued tasks | Reach any route outside `/api/agent/`; see a held task; change anything except through a checked result |
| Someone who knows your email address | Add one held item, up to the daily cap | Reach a model, your list or Now |
| Demo mode (`DEMO=1`) | Skips sign-in on a loopback host only | Open anything on a deployed Worker. A stray `DEMO=1` gets a 401 |

## An email, step by step

1. **It arrives.** Code alone makes a to-do titled `Email: <subject>` with status `held`. No model has read it. It is not ranked and not on your list. The API token cannot see it.
2. **Now asks you.** A card quotes the sender and the start of the text. "Drop it" ends it there, for good.
3. **You tap "Let Claude read it".** A task goes in the queue, with the text in a data block. The bundle holds nothing else of yours.
4. **The runner answers.** It has no web tools in this pass, no Read tool, and its only command is the helper, which reaches only your app. It starts in an empty folder.
5. **The app checks the answer.** For an email only `retitle` of that one to-do counts, and the title stays labelled `Email:`. A date, urgency, another to-do, or an archive is dropped and logged. Every change can be undone on the More screen.

## The walls, and their tests

| Wall | Where | Test |
| --- | --- | --- |
| Outside text cannot close its data block | `src/core/untrusted.ts` | `test/proof/injection.test.ts` |
| Nothing reads a held email before the tap | `src/core/captureBus.ts`, `src/core/agentTasks.ts` | `test/proof/injection.test.ts` |
| The morning plan holds only text you typed | `src/modules/planner/index.ts` | `test/proof/injection.test.ts` |
| Web and no-web passes never mix, on the server as well as the client | `src/core/agentTasks.ts`, `tools/runner/run.mjs` | `test/proof/walls.test.ts`, `test/tools/tools.test.mjs` |
| Each token reaches only its routes | `src/core/auth.ts`, `src/index.ts` | `test/proof/walls.test.ts` |
| A tool cannot make its own to-do urgent | `src/modules/planner/triage.ts` | `test/proof/walls.test.ts` |
| Sign-in is rate limited, cookies are signed, cross-site posts are refused | `src/core/auth.ts` | `test/core/security.test.ts` |
| Internal error text stays on the server | `src/core/errors.ts` | `test/core/security.test.ts` |

## What this does not stop

- **A model can still be fooled inside its small box.** The data block is a convention a model can ignore. The real limit is what the checks let through: the email can steer the wording of its own to-do's title, using words it already holds. You see that title, labelled `Email:`, and you can undo it.
- **You can approve something bad.** The tap is a human check. It works as well as your reading of the quoted text, and long emails are cut in that quote.
- **Your text goes to the model you chose.** Whatever you approve, and whatever you type if you set a model for filing, goes to that provider under its terms.
- **The web pass reads the web.** It answers questions you asked, with web tools, and it gets no other data of yours. A page it reads can try to fool it. Its answer only lands as notes on that one to-do, and only `https` sources are kept.
- **Anyone with your passphrase, or your Cloudflare account, has everything.** The app is single-user and stores your data unencrypted in your own D1.
- **The tokens are long-lived.** Rotate with `npx wrangler secret put`. "Sign out everywhere" ends sessions, and it does not change the tokens.

Report a security problem as described in [.github/SECURITY.md](../.github/SECURITY.md).
