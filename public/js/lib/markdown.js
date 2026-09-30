// The one markdown pipeline: marked, then DOMPurify, so chats, brain notes and sticky notes
// render the same way and nothing unsafe reaches the page. Links open in a new tab.
import { marked, Marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

marked.setOptions({ gfm: true, breaks: false });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});

// Obsidian-style links for the brain viewer: [[Note]], [[Note|shown text]], [[Note#Heading]],
// [[#Heading]], and embeds ![[image.png]]. They become placeholders carrying the target in
// data-wiki; the brain view asks the server where each target is and wires them up. Being a
// marked extension, text inside code spans and code blocks is left alone.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const wikiLink = {
  name: 'wikiLink',
  level: 'inline',
  start: (src) => src.match(/!?\[\[/)?.index,
  tokenizer(src) {
    const m = /^(!?)\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/.exec(src);
    if (m) return { type: 'wikiLink', raw: m[0], embed: !!m[1], target: m[2].trim(), alias: m[3]?.trim() };
  },
  renderer(t) {
    // Shown as Obsidian does: the alias, else "Note › Heading" (a block id ^abc is dropped).
    const [note, ...rest] = t.target.split('#');
    const heading = rest.join('#').replace(/^\^.*/, '');
    const label = t.alias || [note, heading].filter(Boolean).join(' › ') || t.target;
    return `<a class="wiki-link" href="#" data-wiki="${escapeHtml(t.target)}"${t.embed ? ' data-embed="1"' : ''}>${escapeHtml(label)}</a>`;
  }
};
const wikiMarked = new Marked({ gfm: true, breaks: false });
wikiMarked.use({ extensions: [wikiLink] });
const breakMarked = new Marked({ gfm: true, breaks: true });

// Sanitised HTML for markdown text. wiki: also understand Obsidian-style links (the brain
// viewer; chats don't). breaks: every line break shows, for text typed like plain text (notes).
export function renderMarkdown(text, { wiki = false, breaks = false } = {}) {
  const parser = wiki ? wikiMarked : breaks ? breakMarked : marked;
  return DOMPurify.sanitize(parser.parse(text || ''));
}
