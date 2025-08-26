# ResolvCI
ResolvCI automatically analyzes build failures of your github action workflow, using AI to pinpoint the root cause of the error. It then provides intelligent, AI-generated explanation of failure and code fixes directly in your pull requests, helping developers resolve build failures much faster.

## How it works

ResolvCI automatically monitors your GitHub Action workflows. When a build fails, it immediately analyzes the build log and other contextual data.
Using AI, the tool goes beyond simple error messages to identify the exact root cause of the failure. This eliminates the need for developers to manually sift through lengthy logs.

Once the root cause is identified, ResolvCI generates a clear, concise explanation of the failure. It also provides a suggested code fix, which is directly inserted into your pull request.

By providing immediate insights and actionable fixes, ResolvCI significantly reduces the time it takes for developers to resolve build failures and get back to coding.
## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```
