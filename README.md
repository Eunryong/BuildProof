# BuildProof

**BuildProof helps developers demonstrate technical skills through evidence-based interviews and project reviews.**

## What it does

- **AI technical interview:** analyzes a resume with Gemini 3.8 Flash, asks project-specific questions with adaptive follow-ups, and creates a rubric-based report grounded in the candidate's answers.
- **Project evidence review:** lets a reviewer examine a project and record whether the work demonstrates the claimed skill.
- **Verifiable proof:** after reviewing a report, a candidate can publish a minimized assessment manifest and sign its salted hash in a Solana Devnet Memo transaction. The on-chain record commits to that exact manifest; it is not an independent certification of skill.

## How it is built

The browser app is in `src/`. The shared Express API and interview logic are in `server/`; it runs locally or through the Cloudflare Worker entry point in `cloudflare/worker.js`. The hosted demo stores browser-scoped records in Cloudflare D1. Resume content is sent to Google Gemini for analysis, while the original resume file or text is not retained. Published proof links expose the consented assessment manifest; the full interview transcript and resume are not written on-chain.
