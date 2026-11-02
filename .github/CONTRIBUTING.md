# Contributing

Bug reports with steps to reproduce are the most useful thing you can send. Pull requests are welcome if they are small and come with a test.

```sh
npm install
npm run check   # typecheck, all tests, build
npm run e2e     # needs: npx playwright install chromium
```

The app does one job. A new screen or module needs a strong reason. Security proofs in `test/proof` only ever get stricter.
