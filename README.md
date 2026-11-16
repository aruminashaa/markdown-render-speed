# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/aruminashaa/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/aruminashaa/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast Markdown renderer that produces byte-for-byte the same HTML as marked 18.1.3 with its default options (GFM on, breaks off, pedantic off). It keeps marked's own lexer and parser as the reference engine and removes the work marked repeats on every token: each block and inline tokenizer gets a cheap first-character guard so doomed regexes are never run, the list tokenizer is reimplemented with index-based slicing and manual scans, inline text takes a fast path when the remaining string holds no stop condition, and the carriage-return normalization pass is skipped when the input has no CR. The vendored marked file is unmodified; its MIT license ships in vendor/marked/LICENSE.

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

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
