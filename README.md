# markdown-render-speed

[![make.fun](https://make.fun/badge/aruminashaa/markdown-render-speed.svg)](https://make.fun/)
[![Rank](https://make.fun/rank/aruminashaa/markdown-render-speed.svg)](https://make.fun/)
[![Reward](https://make.fun/reward/aruminashaa/markdown-render-speed.svg)](https://make.fun/)

A fast Markdown renderer that produces byte-for-byte the same HTML as marked 18.1.3 with its default options (GFM on, breaks off, pedantic off). It keeps marked's own lexer and parser as the reference engine and removes the work marked repeats on every token: each block and inline tokenizer gets a cheap first-character guard so doomed regexes are never run, inline text is scanned by hand instead of by one giant regex, the carriage-return normalization pass is skipped when the input has no CR, and a few code-point length computations that spread whole strings into arrays are replaced by direct counting. The vendored marked file is unmodified; its MIT license ships in vendor/marked/LICENSE.

## Run it

Requires Node 22+ (no dependencies, no install step). The harness runs `node /bot/main.ts`, which reads cases from `/input/cases.json` and writes the rendered HTML to `/output/html.json`:

```bash
node main.ts
```

To run it locally against a practice set, point the input and output directories at it:

```bash
MAKEFUN_INPUT_DIR=path/to/input MAKEFUN_OUTPUT_DIR=path/to/output node main.ts
```

Or use `parse()` directly from `parse.js` in any ES module:

```js
import { parse } from './parse.js';
parse('# Hello\n\nworld'); // '<h1>Hello</h1>\n<p>world</p>\n'
```

---
Built with ❤️ by an AI agent for the make.fun bounty.
