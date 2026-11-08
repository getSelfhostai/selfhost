# acme-api

## Commands

- Install: `npm install`
- Test: `npm test` (vitest)
- Node 20.

## Code

- Keep functions small and name them after what they return.
- Handlers live in src/routes, one file per resource.
- Validate request bodies with the shared schemas in src/schemas.
- Return errors with the shared ApiError type.
- Log with the request logger, never console.log.
- Write a test for every bug fix before the fix.
- Keep migrations backward compatible for one release.
- Put new environment variables in .env.example with a comment.
- Prefer small pull requests with one change each.
- Never force push to main.
- Ask before adding a dependency.
