// Syntax colouring for the Apps view's editor: HTML (with its <script> and <style>), CSS,
// JavaScript, JSON, Python and Markdown. A small hand-written tokenizer rather than a library:
// it only has to colour common files well enough to read, and every token is put on the page as
// text (textContent), never as HTML. Each language is a list of sticky regexes tried in order at
// each position; the first that matches gives the token's kind (null: plain text).
import { h } from './dom.js';

const STRING = /"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/y;
const NUMBER = /\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b/y;
const SPACE = /\s+/y;

const JS = [
  ['comment', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
  ['string', /`(?:\\[\s\S]|[^\\`])*`?/y],
  ['string', STRING],
  ['keyword', /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|null|undefined|true|false|yield|delete|void|static|get|set)\b/y],
  ['number', NUMBER],
  ['fn', /[A-Za-z_$][\w$]*(?=\s*\()/y],
  [null, /[A-Za-z_$][\w$]*/y],
  [null, SPACE]
];
const PY = [
  ['comment', /#[^\n]*/y],
  ['string', /[rbfuRBFU]{0,2}("""|''')[\s\S]*?(?:\1|$)/y],
  ['string', /[rbfuRBFU]{0,2}(?:"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?)/y],
  ['keyword', /\b(?:def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|lambda|yield|pass|break|continue|global|nonlocal|async|await|assert|del|match|case)\b/y],
  ['attr', /@[\w.]+/y],
  ['number', NUMBER],
  ['fn', /[A-Za-z_]\w*(?=\s*\()/y],
  [null, /[A-Za-z_]\w*/y],
  [null, SPACE]
];
const CSS = [
  ['comment', /\/\*[\s\S]*?(?:\*\/|$)/y],
  ['string', STRING],
  ['keyword', /@[\w-]+|!important\b/y],
  ['attr', /--?[A-Za-z][\w-]*(?=\s*:)|[A-Za-z][\w-]*(?=\s*:(?!:|[\w-]+\s*[{,]))/y],
  ['number', /#[\da-fA-F]{3,8}\b|-?\b\d*\.?\d+(?:%|[a-zA-Z]+)?/y],
  ['tag', /[.#][A-Za-z_-][\w-]*/y],
  [null, /[A-Za-z_-][\w-]*/y],
  [null, SPACE]
];
const JSON_RULES = [
  ['attr', /"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/y],
  ['string', /"(?:\\[\s\S]|[^"\\\n])*"?/y],
  ['keyword', /\b(?:true|false|null)\b/y],
  ['number', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
  [null, SPACE]
];
const MD = [
  ['string', /(?<=^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*|$)/y],
  ['keyword', /(?<=^|\n)#{1,6}[ \t][^\n]*/y],
  ['comment', /(?<=^|\n)>[^\n]*/y],
  ['string', /`[^`\n]*`/y],
  ['attr', /!?\[[^\]\n]*\]\([^)\n]*\)/y],
  ['fn', /\*\*[^*\n]+\*\*|__[^_\n]+__/y],
  ['number', /(?<=^|\n)[ \t]*(?:[-*+]|\d+[.)])(?=[ \t])/y],
  [null, /[A-Za-z0-9]+/y],
  [null, SPACE]
];

function lex(text, rules, out) {
  let i = 0, plain = '';
  const flush = () => { if (plain) { out.push([null, plain]); plain = ''; } };
  outer: while (i < text.length) {
    for (const [kind, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m[0].length) {
        if (kind) { flush(); out.push([kind, m[0]]); } else plain += m[0];
        i += m[0].length;
        continue outer;
      }
    }
    plain += text[i++];
  }
  flush();
  return out;
}

// HTML keeps track of whether it's inside a tag, so an apostrophe in ordinary text isn't
// read as the start of a string; <script> and <style> bodies are coloured as JS and CSS.
const TAG_ATTR = [
  ['string', /"[^"]*"?|'[^']*'?/y],
  ['attr', /[^\s=/>"']+/y],
  [null, /\s+|=/y]
];
function lexHtml(text, out) {
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { out.push([null, text.slice(i)]); break; }
    if (lt > i) out.push([null, text.slice(i, lt)]);
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      const stop = end < 0 ? text.length : end + 3;
      out.push(['comment', text.slice(i, stop)]); i = stop; continue;
    }
    const open = /<\/?[A-Za-z!][\w:-]*/y;
    open.lastIndex = i;
    const m = open.exec(text);
    if (!m) { out.push([null, '<']); i++; continue; }
    out.push(['tag', m[0]]);
    i += m[0].length;
    // The tag's attributes, up to its closing >.
    let close = i;
    for (let quote = null; close < text.length; close++) {
      const c = text[close];
      if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === '\'') quote = c; else if (c === '>') break;
    }
    const attrs = text.slice(i, close);
    const selfClose = attrs.endsWith('/');
    lex(selfClose ? attrs.slice(0, -1) : attrs, TAG_ATTR, out);
    if (close < text.length) out.push(['tag', selfClose ? '/>' : '>']);
    else if (selfClose) out.push([null, '/']);
    i = close + 1;
    const name = m[0].slice(1).toLowerCase();
    if ((name === 'script' || name === 'style') && i < text.length) {
      const end = text.toLowerCase().indexOf(`</${name}`, i);
      const stop = end < 0 ? text.length : end;
      lex(text.slice(i, stop), name === 'script' ? JS : CSS, out);
      i = stop;
    }
  }
  return out;
}

const BY_EXT = {
  js: JS, mjs: JS, cjs: JS, ts: JS, jsx: JS, tsx: JS, py: PY, css: CSS, json: JSON_RULES, webmanifest: JSON_RULES,
  md: MD, markdown: MD, html: 'html', htm: 'html', xml: 'html', svg: 'html'
};
export const languageOf = (name) => BY_EXT[String(name).split('.').pop().toLowerCase()] ? String(name).split('.').pop().toLowerCase() : null;

// The text as coloured spans. Files without a known language, or very large ones, stay plain.
export function highlight(text, name) {
  const rules = BY_EXT[String(name).split('.').pop().toLowerCase()];
  const frag = document.createDocumentFragment();
  if (!rules || text.length > 400000) { frag.append(text); return frag; }
  const tokens = rules === 'html' ? lexHtml(text, []) : lex(text, rules, []);
  for (const [kind, s] of tokens) frag.append(kind ? h('span', { class: `tk-${kind}` }, s) : s);
  return frag;
}
