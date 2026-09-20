# Zendrop

Resumable, verified, large-file peer-to-peer transfer in the browser. See [idea.md](idea.md) for the full plan.

## Develop

```sh
npm install
npm run dev        # start the app
npm test           # run tests in watch mode
npm run typecheck
npm run lint
```

## Layout

```text
src/core/   transfer logic (no DOM) — written by hand
src/ui/     browser UI
docs/decisions/  one short file per design decision (why X over Y)
```
