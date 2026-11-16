// Driver for the markdown-render-speed-02 bounty: the harness runs
// `node /bot/main.ts`. It reads every case from /input/cases.json (an array
// of {id, markdown}), renders each one alone with parse() from parse.js, and
// writes /output/html.json: the HTML strings in the cases' order.
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output. Written for this entry; not the baseline's driver.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const rawCases: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases: { id: string; markdown: string }[] = JSON.parse(rawCases);
const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
