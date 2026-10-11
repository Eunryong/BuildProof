# BuildProof

BuildProof is a hosted skill-proof prototype. Its AI Interview flow sends a resume to Gemini 3.8 Flash, asks personalized technical questions with adaptive follow-ups, and produces a rubric report with answer excerpts. The separate Review Desk prototype lets a reviewer check a project link and sign a SHA-256 commitment to that claim in a Solana Devnet Memo transaction.

Resume files/text and interview answers are sent to the configured Gemini API. The original resume file/text is not retained. On the hosted demo, extracted profiles, interview questions, answers, completed reports, review submissions, and published proof manifests are stored in Cloudflare D1 and scoped to a browser cookie. Delete a saved interview from the app to remove its interview state. A candidate can separately choose to publish a minimized report manifest. The Solana Memo contains only a salted SHA-256 hash of that public manifest. A wallet is needed to anchor a Devnet proof and must have Devnet SOL for the transaction fee.

## Run locally

Use Node.js 20 or newer.

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:8891`. The local server binds to loopback by default and stores submissions, interview state, and consented interview proof manifests under `data/`. The AI interview has direct routes for its stages: `/interview` starts or reopens work, `/interviews/:sessionId` resumes an active interview, and `/reports/:reportId` reopens a completed report. The Review Desk and issued proofs are at `/review` and `/proofs`.

To enable AI interviews, set `GEMINI_API_KEY` in `.env` to a key from Google AI Studio (create `.env` from `.env.example` if needed). The model defaults to `gemini-3.8-flash`; `GEMINI_MODEL` can override it. The key is read by the server and is never sent to the browser. Keep `.env` private and do not commit it.

To issue a proof, install a Solana wallet such as Phantom and connect a Devnet wallet. BuildProof sends browser RPC calls through its same-origin server proxy, so a configured provider key stays on the server. The default is Solana's public Devnet endpoint; set `SOLANA_RPC_URL` in `.env` to a Helius Devnet endpoint to use Helius. The app does not create a token or a custom Solana program.

For a local production build:

```sh
npm run build
npm start
```

The default server address is `127.0.0.1:8891`. `PORT`, `HOST`, `SOLANA_RPC_URL`, and `BUILDPROOF_DATA_DIR` can be set for local development. The prototype has no account system or reviewer authorization. Published interview proof links are public and expose the report manifest, including rubric observations and selected answer excerpts.

## Hosted demo on Cloudflare

The public demo runs as a Cloudflare Worker with static assets and a D1 database; it does not depend on a developer computer or a Cloudflare Tunnel. The deployed demo is [buildproof.eunryong.com](https://buildproof.eunryong.com). A secure, HttpOnly, SameSite cookie scopes each visitor's records. Clearing that cookie makes those browser-scoped records inaccessible. This prototype has no account recovery or multi-user reviewer authorization, so it is intended for demos rather than sensitive production use.

To deploy your own instance:

1. Install dependencies and authenticate Wrangler with a Cloudflare account that controls the chosen domain.
2. Create a D1 database named `buildproof`, then put its database ID in `wrangler.jsonc`.
3. Apply the D1 migration and configure the required secrets. Never commit secret values.
4. Update the Worker route in `wrangler.jsonc` for your domain, then deploy.

```sh
npm install
npx wrangler login
npx wrangler d1 create buildproof
npx wrangler d1 migrations apply buildproof --remote
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put BUILDPROOF_SESSION_SECRET
npm run deploy
```

`BUILDPROOF_SESSION_SECRET` must be a random value with at least 32 characters. The deployed project configuration already contains the D1 ID and route for the maintainer's instance. For local Worker emulation, create a private `.dev.vars` file with the same two secrets; that file is git-ignored.

## Review flow

1. Add a project name, skill, evidence URL, and the builder's public wallet address.
2. Inspect the linked work and complete all three rubric checks. If changes are needed, the submitter can edit the evidence and return it to the queue.
3. Approve the review and connect the reviewer/issuer wallet.
4. Sign the Devnet Memo transaction. BuildProof checks that the transaction succeeded, contains the expected claim hash, and was signed by the displayed issuer.
5. Share the verification link. The verifier recalculates the claim hash and checks the transaction on Devnet.

## AI interview flow

1. Open `/interview` and choose one resume source: upload a PDF/TXT/Markdown file, paste resume text, or enter a public direct HTTPS link to a PDF/TXT/Markdown file up to 700 KB.
2. Gemini extracts supported skill and project claims and asks one technical question grounded in the resume.
3. Continue at `/interviews/:sessionId`. Each submitted answer is saved before Gemini generates the next question, so a quota or network error does not erase the answer; retrying or reopening the page resumes that interview.
4. Answer five questions. Gemini uses each answer to choose the next technical follow-up. The final report opens at `/reports/:reportId` and can be revisited from the saved-interview list.
5. Review the report, which scores technical accuracy, reasoning, project ownership, technical depth, and consistency with the resume. Answer excerpts are checked against the original answers before they are shown as evidence.

After reviewing the report, the candidate can explicitly publish and anchor a public assessment manifest. It contains the model and rubric version, question count, criterion scores and observations, selected answer excerpts, and evidence coverage; it excludes the resume and full transcript. The server creates the manifest from its Gemini-generated report, computes its hash, and stores a pending draft. The candidate's wallet signs a Devnet Memo containing that hash. The server verifies the signer and transaction before marking the manifest issued. The public verification page loads the manifest from the server, recomputes its hash, and checks it against the transaction. This proves that the candidate wallet anchored that exact report; it is not an independent certification of the candidate's skills.

Use a commit-specific repository URL when possible. A link to a moving branch can point to different code after the review, so the proof records the reference that the reviewer saw but cannot preserve the project itself.

## Prototype limits

- A Devnet memo proves that the candidate wallet signed a commitment to a specific interview report. It does not establish that the scores are objectively calibrated or independently certified.
- Review and issuance happen in the same app. There is no learner/reviewer account separation or account-based recovery yet.
- The current rubric is fixed at version 1. It checks that evidence works, the learner's contribution is clear, and the work demonstrates the selected skill.
- A hash commitment makes later changes detectable, but does not guarantee that an evidence link will remain available.
- AI interview scores are a prototype snapshot, not a validated hiring decision or complete certification.
- Gemini API access is required for the AI Interview view. Uploaded, pasted, and linked resume content is sent to Google Gemini; linked files are fetched temporarily by the BuildProof server. Only public HTTPS direct-file links are accepted; private preview pages are not supported. On the hosted demo, extracted profiles, answers, and reports remain in D1 until deleted, so do not submit data without permission to process it through Gemini and retain it in the demo database.

## Test

```sh
npm test
```

