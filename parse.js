// Fast marked-compatible Markdown renderer for the make.fun
// "Make Markdown rendering faster" bounty.
//
// Strategy: keep marked 18.1.3's own lexer/parser (vendored under
// vendor/marked/) — it is the reference implementation, so its output is
// definitionally correct — and cut the work it repeats for every block and
// every inline run:
//
//  * Marked's loops try every block tokenizer (~12) and every inline
//    tokenizer (~11) in turn until one matches, so each token costs many
//    doomed regex executions. FastTokenizer adds a cheap first-character
//    guard to every tokenizer: a tokenizer whose pattern cannot start with
//    the character at hand is never run. A guard only ever skips a pattern
//    that provably cannot match at this position, so output is unchanged.
//  * The list tokenizer is reimplemented with the same output but far
//    less per-line work: index-based line slicing instead of split(),
//    a first-character dispatch instead of six regex tests per line,
//    and manual scans instead of search()/trim() calls.
//  * Inline text gets a fast path: when the remaining string holds no
//    stop condition at all, the text token is the whole string, so the
//    giant inline-text regex never runs for plain paragraphs.
//  * Lexer.lex normalizes carriage returns with a regex over the whole
//    input; FastLexer skips that pass when the input has no CR at all
//    (the common case) — the replace is a no-op then anyway.
//
// The vendored marked file is unmodified (see vendor/marked/NOTICE).
// marked is MIT-licensed; its LICENSE ships in vendor/marked/LICENSE.

import { Lexer, Parser, Tokenizer, defaults } from './vendor/marked/marked.esm.js';

// Matches any substring that could end an inline-text run: a special
// character (\ < ! [ ` * ~ _), an '@' (a bare email stops the run), a
// protocol word (http/https stop it even without '://'; ftp only as
// ftp://, but 'ftp' alone is a safe superset), a 'www.', a mailto:/xmpp:,
// or two spaces plus a newline (a hard break). Case-insensitive so it
// never misses a stop; anything it matches is handled by the original
// inlineText, so over-matching only costs the fallback, never correctness.
const TEXT_STOP = /[\\<!\[`*~_@]|http|ftp|www\.|mailto:|xmpp:|  \n/i;

// ---------------------------------------------------------------------------
// First-character dispatch for block starts
// ---------------------------------------------------------------------------

// What the first line of `src` looks like, for block-tokenizer guards.
// Returns:
//   0  — the line is blank (only spaces/tabs, then a newline or end of input)
//  -1  — the first non-space character sits at column 4 or beyond, i.e. the
//        line is indented code territory (spaces count 1 column, a tab jumps
//        to the next multiple of 4)
//  >0  — the char code of the first non-space character, which sits within
//        the first three columns
//
// Every block pattern except `space` and `code` anchors on ` {0,3}` plus a
// specific opening character, so knowing the first character and its column
// tells us exactly which tokenizers can possibly match.
function blockStart(src) {
  let col = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 32) {
      // space
      col++;
      continue;
    }
    if (c === 9) {
      // tab: advance to the next multiple of 4
      col += 4 - (col % 4);
      continue;
    }
    if (c === 10 || c === 13) return 0; // newline: blank line
    return col >= 4 ? -1 : c;
  }
  return 0; // empty, or whitespace only
}

// Is the character code the start of a URL token? The url pattern's
// alternatives all begin with a letter, a digit, or one of . _ + -.
function isUrlStart(c) {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 46 || // .
    c === 95 || // _
    c === 43 || // +
    c === 45 // -
  );
}

// The second line of src (the line after the first newline), or null when
// there is no second line.
function secondLine(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return null;
  const start = nl + 1;
  const end = src.indexOf('\n', start);
  return end === -1 ? src.slice(start) : src.slice(start, end);
}

// Could a table start here? The table pattern needs a header line and then a
// delimiter row; the delimiter row must contain a '-' (its `-+` cells) and
// either ':' or '|' (the table method rejects delimiter rows without them).
// This is a pure filter: "false" means the pattern cannot match, "true"
// means "run the regex and let it decide".
function maybeTable(src) {
  const line = secondLine(src);
  if (line === null) return false;
  return line.includes('-') && (line.includes(':') || line.includes('|'));
}

// Could a setext (lheading) heading start here? The setext pattern needs an
// underline line — up to three spaces, then a run of '=' or a run of '-',
// then only spaces/tabs to the end of the line — before the first blank
// line (the heading's text cannot cross a blank line). Pure filter, as above:
// "false" is a proof the pattern cannot match.
function maybeLheading(src) {
  let pos = src.indexOf('\n');
  if (pos === -1) return false;
  pos++;
  while (pos < src.length) {
    let end = src.indexOf('\n', pos);
    if (end === -1) end = src.length;
    // Skip up to three leading spaces.
    let i = pos;
    let spaces = 0;
    while (i < end && src.charCodeAt(i) === 32 && spaces < 3) {
      i++;
      spaces++;
    }
    if (i >= end) return false; // blank line: no underline can follow
    const c = src.charCodeAt(i);
    if (c === 61 || c === 45) {
      // '=' or '-': the rest of the line must be only that character,
      // spaces, or tabs for this to be a setext underline.
      let ok = true;
      for (let j = i + 1; j < end; j++) {
        const d = src.charCodeAt(j);
        if (d !== c && d !== 32 && d !== 9) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    pos = end + 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers for the optimized list tokenizer
// ---------------------------------------------------------------------------

// The first line of str (up to the first newline, or the whole string).
// Cheaper than str.split('\n', 1)[0]: no array allocation.
function firstLine(str) {
  const nl = str.indexOf('\n');
  return nl === -1 ? str : str.slice(0, nl);
}

// The index of the first character of str that is not a space, or -1 when
// str is all spaces (or empty). Equivalent to str.search(/[^ ]/).
function firstNonSpace(str) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) !== 32) return i;
  }
  return -1;
}

// True when the character code is JavaScript whitespace (\s): space, tab,
// vertical tab, form feed, carriage return, NBSP, Ogham space, en quad
// through hair space, line/paragraph separators, narrow NBSP, medium
// mathematical space, ideographic space, BOM. (Newline is whitespace too
// but never appears inside a single line.)
function isSpaceChar(c) {
  return (
    c === 32 ||
    c === 9 ||
    c === 11 ||
    c === 12 ||
    c === 13 ||
    c === 160 ||
    c === 5760 ||
    (c >= 8192 && c <= 8202) ||
    c === 8232 ||
    c === 8233 ||
    c === 8239 ||
    c === 8287 ||
    c === 12288 ||
    c === 65279
  );
}

// True when str is empty or holds only whitespace — equivalent to
// str.trim() === '' but without allocating the trimmed string.
function isTrimBlank(str) {
  for (let i = 0; i < str.length; i++) {
    if (!isSpaceChar(str.charCodeAt(i))) return false;
  }
  return true;
}

// True when str is empty or holds only spaces and tabs — equivalent to
// /^[ \t]*$/.test(str).
function isSpaceTabBlank(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Expands tabs in str to spaces, starting at column startCol (a tab jumps
// to the next multiple of 4). Mirrors marked's internal tab expander,
// which counts code points, not code units.
function expandTabs(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Expands the leading tabs of a line (column 0), as the list tokenizer
// does with its leading-whitespace replace. When the leading whitespace
// holds no tab the line is returned unchanged.
function expandLeadingTabs(line) {
  let i = 0;
  let hasTab = false;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      i++;
      continue;
    }
    if (c === 9) {
      hasTab = true;
      i++;
      continue;
    }
    break;
  }
  if (!hasTab) return line;
  return expandTabs(line.slice(0, i), 0) + line.slice(i);
}

// The column of the first non-space character of str when every tab counts
// as four columns — equivalent to str.replace(/\t/g, '    ').search(/[^ ]/)
// without building the replaced string.
function firstNonSpaceColTabs4(str) {
  let col = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 32) {
      col++;
      continue;
    }
    if (c === 9) {
      col += 4;
      continue;
    }
    return col;
  }
  return -1;
}

// Does this line start a new block at indent R — a fenced code block, an
// ATX heading, an HTML block, a blockquote, the next list bullet, or a
// horizontal rule? The reference tests six regexes per line; this dispatch
// reads the first non-space character (within R spaces, the patterns'
// ` {0,R}` anchor) and only runs a regex where the character could match
// one. Fences, headings and blockquotes are checked by hand (their
// patterns are exact here); HTML, bullets and hr keep their regexes.
// `re` holds { html, bullet, hr } — the prebuilt regexes for indent R.
// In pedantic mode a heading is any line starting with '#' (no run-length
// or whitespace requirement), so that case is checked first.
//
// Note the patterns' space allowance is NOT R: marked's regex factory
// clamps the indent to N = clamp(R - 1, 0, 3) before building them (its
// memoizer maps R onto 0..3), so a line indented more than N spaces never
// starts a block here even when it is inside the item's content indent.
function lineStartsBlock(line, R, re, pedantic) {
  const N = Math.max(0, Math.min(3, R - 1));
  let i = 0;
  while (i < N && i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < line.length && line.charCodeAt(i) === 32) return false; // >N spaces
  if (i >= line.length) return false; // blank line
  const c = line.charCodeAt(i);
  if (c === 96 || c === 126) {
    // fences: ``` or ~~~
    return line.charCodeAt(i + 1) === c && line.charCodeAt(i + 2) === c;
  }
  if (c === 35) {
    // ATX heading: pedantic needs only '#'; otherwise 1-6 # then
    // whitespace or end of line
    if (pedantic) return true;
    let j = i;
    let n = 0;
    while (j < line.length && line.charCodeAt(j) === 35 && n < 6) {
      j++;
      n++;
    }
    if (n === 0) return false;
    if (j >= line.length) return true;
    return isSpaceChar(line.charCodeAt(j));
  }
  if (c === 62) return true; // blockquote: >
  if (c === 60) return re.html.test(line); // HTML block: < (regex decides)
  if (c === 45 || c === 43 || c === 42 || (c >= 48 && c <= 57)) {
    // bullet (-, +, *, digit) and hr (-, *) both possible
    if (re.bullet.test(line)) return true;
    if ((c === 45 || c === 42) && re.hr.test(line)) return true;
    return false;
  }
  if (c === 95) return re.hr.test(line); // hr: _
  return false;
}

// ---------------------------------------------------------------------------
// FastTokenizer: marked's Tokenizer with first-character guards
// ---------------------------------------------------------------------------

class FastTokenizer extends Tokenizer {
  // space matches only blank lines.
  space(src) {
    if (blockStart(src) !== 0) return undefined;
    return super.space(src);
  }

  // code (indented) matches only when the first character is at column 4+.
  code(src) {
    if (blockStart(src) !== -1) return undefined;
    return super.code(src);
  }

  // fences start with ` or ~.
  fences(src) {
    const c = blockStart(src);
    if (c !== 96 && c !== 126) return undefined;
    return super.fences(src);
  }

  // ATX headings start with #.
  heading(src) {
    if (blockStart(src) !== 35) return undefined;
    return super.heading(src);
  }

  // hr starts with -, _, or *.
  hr(src) {
    const c = blockStart(src);
    if (c !== 45 && c !== 95 && c !== 42) return undefined;
    return super.hr(src);
  }

  // blockquotes start with >.
  blockquote(src) {
    if (blockStart(src) !== 62) return undefined;
    return super.blockquote(src);
  }

  // lists start with -, +, *, or a digit. This is a reimplementation of
  // marked's list tokenizer with the same output: the per-line work is
  // what makes lists the hottest block tokenizer, so the inner loop uses
  // index-based line slicing instead of split(), a first-character
  // dispatch instead of six regex tests per line, and manual scans
  // instead of search()/trim() calls. The item/bullet matching, the
  // loose/tight and task-item handling, and the recursive tokenization
  // follow the reference exactly.
  list(src) {
    const startC = blockStart(src);
    if (startC !== 45 && startC !== 43 && startC !== 42 && (startC < 48 || startC > 57))
      return undefined;
    let t = this.rules.block.list.exec(src);
    if (!t) return undefined;
    const other = this.rules.other;
    const pedantic = this.options.pedantic;
    let e = src;
    const n = e;
    const consumed = () => n.length - e.length;
    let r = t[1].trim();
    const ordered = r.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +r.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    r = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
    if (pedantic) r = ordered ? r : '[*+-]';
    const itemRe = other.listItemRegex(r);
    let seenDoubleBlank = false;
    for (; e; ) {
      let blankItem = false;
      let d = '';
      if (!(t = itemRe.exec(e)) || this.rules.block.hr.test(e)) break;
      const k = consumed();
      e = e.substring(t[0].length);
      const g = firstLine(t[2]);
      const b = t[1].length;
      const m0 = pedantic
        ? expandTabs(g, b)
        : g.replace(other.leadingSpaceTab, (v) => expandTabs(v, b));
      let f = firstLine(e);
      let y = isTrimBlank(m0);
      let R = 0;
      let m = m0;
      if (pedantic) {
        R = 2;
        d = m0.trimStart();
      } else if (y) {
        R = b + 1;
      } else {
        R = firstNonSpace(m0);
        R = R > 4 ? 1 : R;
        d = m0.slice(R);
        R += b;
      }
      if (y && isSpaceTabBlank(f)) {
        e = e.substring(f.length + 1);
        blankItem = true;
      }
      if (!blankItem) {
        const re = {
          bullet: other.nextBulletRegex(R),
          hr: other.hrRegex(R),
          fences: other.fencesBeginRegex(R),
          heading: pedantic
            ? other.pedanticHeadingBeginRegex(R)
            : other.headingBeginRegex(R),
          html: other.htmlBeginRegex(R),
        };
        for (; e; ) {
          const U = firstLine(e);
          let Z;
          f = U;
          if (pedantic) {
            f = f.replace(other.listReplaceNesting, '  ');
            Z = f;
          } else {
            Z = expandLeadingTabs(f);
          }
          if (lineStartsBlock(f, R, re, pedantic)) break;
          if (firstNonSpace(Z) >= R || isTrimBlank(f)) {
            d += '\n' + Z.slice(R);
          } else {
            if (
              y ||
              firstNonSpaceColTabs4(m) >= 4 ||
              re.fences.test(m) ||
              re.heading.test(m) ||
              re.html.test(m) ||
              re.hr.test(m)
            )
              break;
            const qe =
              !pedantic &&
              /^ {0,3}(?:=+|-+) *$/.test(f) &&
              this.rules.block.lheading.test(`${m}\n${f}`)
                ? `    ${Z.replace(/^ {0,3}/, '')}`
                : f;
            d += '\n' + qe;
          }
          y = isTrimBlank(f);
          e = e.substring(U.length + 1);
          m = Z.slice(R);
        }
      }
      const A = n.slice(k, consumed());
      if (!list.loose) {
        if (seenDoubleBlank) list.loose = true;
        else if (other.doubleBlankLine.test(A)) seenDoubleBlank = true;
      }
      list.items.push({
        type: 'list_item',
        raw: A,
        task: !!this.options.gfm && other.listIsTask.test(d),
        loose: false,
        text: d,
        tokens: [],
      });
    }
    const last = list.items.at(-1);
    if (!last) return undefined;
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
    list.raw = n.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((g) => g.type === 'space');
        list.loose =
          spaces.length > 0 && spaces.some((g) => other.anyLine.test(g.raw));
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(other.listReplaceTask, '');
        first.raw = first.raw.replace(other.listReplaceTask, '');
        first.text = first.text.replace(other.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(
              other.listReplaceTask,
              '',
            );
            break;
          }
        }
        const ck = other.listTaskCheckbox.exec(item.raw);
        if (ck) {
          const box = { type: 'checkbox', raw: ck[0] + ' ', checked: ck[0] !== '[ ]' };
          item.checked = box.checked;
          if (list.loose) {
            if (
              item.tokens[0] &&
              ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = box.raw + item.tokens[0].raw;
              item.tokens[0].text = box.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(box);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: box.raw,
                text: box.raw,
                tokens: [box],
              });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const tok of item.tokens) {
          if (tok.type === 'text') tok.type = 'paragraph';
        }
      }
    }
    return list;
  }

  // HTML blocks start with <.
  html(src) {
    if (blockStart(src) !== 60) return undefined;
    return super.html(src);
  }

  // link definitions start with [.
  def(src) {
    if (blockStart(src) !== 91) return undefined;
    return super.def(src);
  }

  // tables need a header plus a delimiter row on the second line.
  table(src) {
    if (blockStart(src) === 0 || !maybeTable(src)) return undefined;
    return super.table(src);
  }

  // setext headings need an underline before the first blank line.
  lheading(src) {
    if (blockStart(src) === 0 || !maybeLheading(src)) return undefined;
    return super.lheading(src);
  }

  // paragraph and text have no guard: they are the fallbacks.
  paragraph(src) {
    return super.paragraph(src);
  }

  text(src) {
    return super.text(src);
  }

  // Inline tokenizers: guard on the very first character of the remainder.

  // escape starts with a backslash.
  escape(src) {
    if (src.charCodeAt(0) !== 92) return undefined;
    return super.escape(src);
  }

  // tags start with <.
  tag(src) {
    if (src.charCodeAt(0) !== 60) return undefined;
    return super.tag(src);
  }

  // links start with [ or ![.
  link(src) {
    const c = src.charCodeAt(0);
    if (c !== 91 && (c !== 33 || src.charCodeAt(1) !== 91)) return undefined;
    return super.link(src);
  }

  // reference links start with [ or ![. (The second argument is the
  // link-reference table the lexer passes along; forward it.)
  reflink(src, links) {
    const c = src.charCodeAt(0);
    if (c !== 91 && (c !== 33 || src.charCodeAt(1) !== 91)) return undefined;
    return super.reflink(src, links);
  }

  // emphasis starts with * or _. (The lexer also passes the full inline
  // string and the preceding character; forward both.)
  emStrong(src, full, prev) {
    const c = src.charCodeAt(0);
    if (c !== 42 && c !== 95) return undefined;
    return super.emStrong(src, full, prev);
  }

  // code spans start with a backtick.
  codespan(src) {
    if (src.charCodeAt(0) !== 96) return undefined;
    return super.codespan(src);
  }

  // hard breaks are two spaces + newline, or backslash + newline.
  br(src) {
    const c = src.charCodeAt(0);
    if (c === 32) {
      if (src.charCodeAt(1) !== 32) return undefined;
    } else if (c === 92) {
      if (src.charCodeAt(1) !== 10) return undefined;
    } else {
      return undefined;
    }
    return super.br(src);
  }

  // strikethrough starts with ~. (Forwards the full string and the
  // preceding character, as with emStrong.)
  del(src, full, prev) {
    if (src.charCodeAt(0) !== 126) return undefined;
    return super.del(src, full, prev);
  }

  // autolinks start with <.
  autolink(src) {
    if (src.charCodeAt(0) !== 60) return undefined;
    return super.autolink(src);
  }

  // bare URLs start with a letter, digit, or . _ + -.
  url(src) {
    if (!isUrlStart(src.charCodeAt(0))) return undefined;
    return super.url(src);
  }

  // inlineText has no guard: it is the fallback. Its regex is one giant
  // pattern with lazy scans and lookaheads, so this override adds a fast
  // path: when the whole remaining string holds no stop condition at all
  // (no special character, no http/ftp/www./mailto:/xmpp:, no '@', no
  // two-spaces-plus-newline), the text token is the entire string. The
  // test pattern is a conservative superset of the real stops — anything
  // it matches falls back to the original method, which decides exactly.
  // The reference decoder only changes strings holding a numeric
  // character reference (&#...;); without '&#' the token's text is the
  // match itself, so the token is built directly.
  inlineText(src) {
    if (src.length === 0) return undefined;
    if (!TEXT_STOP.test(src) && src.indexOf('&#') === -1) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: 'text', raw: src, text: src, escaped: inRaw };
    }
    return super.inlineText(src);
  }
}

// ---------------------------------------------------------------------------
// FastLexer: marked's Lexer that skips the carriage-return normalization
// pass when the input contains no carriage return (the common case).
// ---------------------------------------------------------------------------

class FastLexer extends Lexer {
  lex(src) {
    // Lexer.lex normalizes \r\n and \r to \n with a regex over the whole
    // input. When there is no \r at all that replace is a no-op, so skip
    // it — but otherwise do exactly what Lexer.lex does: block-tokenize
    // into this.tokens, then drain the inline queue. (Tokenizer.inline
    // only queues its work; inlineTokens, run here, fills the token
    // arrays the block tokens already reference.)
    if (!src.includes('\r')) {
      this.blockTokens(src, this.tokens);
      for (let i = 0; i < this.inlineQueue.length; i++) {
        const item = this.inlineQueue[i];
        this.state.inRawBlock = false;
        this.inlineTokens(item.src, item.tokens);
      }
      this.inlineQueue = [];
      return this.tokens;
    }
    return super.lex(src);
  }
}

// ---------------------------------------------------------------------------
// parse: the entry point. Renders `markdown` exactly as marked.parse does
// with marked's default options (gfm, no breaks, no pedantic, sync).
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const options = { ...defaults, tokenizer: new FastTokenizer() };
  const tokens = new FastLexer(options).lex(markdown);
  return Parser.parse(tokens, options);
}

// Exported for debugging; the harness only uses parse().
export { FastLexer, FastTokenizer };
