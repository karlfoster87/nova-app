// What the page knows, shared by the shell and the chat modules: the signed-in profile (me),
// Claude's state (meta), the chat list and each chat's transcript, and the composer's files.
// Plus the fixed elements of the chat column in index.html.
import { $ } from './lib/dom.js';

export const state = {
  me: null,               // /api/me: profile, role, access, prefs, limits
  meta: null,             // models, account, usage (the server's 'meta' message)
  chats: [],
  categories: [],
  chatState: new Map(),   // chatId -> idle | running | closed
  unread: new Set(),      // chats that finished while not open
  transcripts: new Map(), // chatId -> Transcript
  current: null,          // chatId or null for an unsent new chat
  pending: null,          // { text, attachments, voice } of a new chat's first message, waiting for its id
  speakFor: new Set(),    // chats whose last message this tab sent with spoken replies on
  attachments: [],        // files in the composer: { key, name, size, type, id?, progress?, error?, xhr? }
  draft: { categoryId: null }, // where the unsent new chat will be filed
  ws: null
};

export const els = {
  chatList: $('chatList'), transcript: $('transcript'),
  model: $('modelSelect'), effort: $('effortSelect'), effortWrap: $('effortWrap'), mode: $('modeSelect'), usage: $('usage'),
  input: $('input'), composer: $('composer'), send: $('sendBtn'), stop: $('stopBtn'),
  attachList: $('attachList'), attachBtn: $('attachBtn'), fileInput: $('fileInput'), mic: $('micBtn'), speak: $('speakBtn'),
  presence: $('presence'), sidebar: $('sidebar'),
  chatTitle: $('chatTitle'), chatWhere: $('chatWhere'), chatState: $('chatState'), link: $('linkState')
};

export const titleOf = (id) => state.chats.find((c) => c.id === id)?.title || 'New chat';
