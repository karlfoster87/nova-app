// The Outlook COM provider: runs outlook.ps1 (beside this file) in Windows PowerShell, one request
// at a time, and turns what it reports into plain errors. COM was chosen over Microsoft Graph and the
// claude.ai Microsoft 365 connector because it needs no app registration or sign-in, costs no plan
// usage, and reads Outlook's local copy, so listing mail never shows it to the model. It only works
// where classic Outlook runs, and attaches to the copy that is open: it never starts Outlook.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'outlook.ps1');

const ERRORS = {
  'not-running': ['Outlook isn\'t open on this computer. Open classic Outlook (not the new Outlook app) and try again.', 409],
  gone: ['Outlook can\'t find that email any more. It may have been moved or deleted. Refresh the list and try again.', 404],
  'not-mail': ['That item is an Outlook task, not an email, so there\'s nothing to reply to.', 400]
};

// Requests queue behind each other: Outlook's object model is single-threaded anyway, and one
// PowerShell at a time keeps a burst of clicks from starting several.
let queue = Promise.resolve();
export function runOutlook(request) {
  const next = queue.then(() => once(request));
  queue = next.catch(() => {});
  return next;
}

function once(request) {
  return new Promise((resolve, reject) => {
    const seconds = Math.max(5, Number(config.email.timeoutSec) || 30);
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); fn(value); };
    // A security prompt in Outlook ("A program is trying to access…") would otherwise hold the request for ever.
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new UserError(`Outlook didn't answer within ${seconds} seconds. If it's showing a message such as "A program is trying to access…", ` +
        'answer it. If it keeps happening, your organisation may block other programs from reading Outlook: ask IT, or turn email off in Settings.', 504));
    }, seconds * 1000);
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, new UserError(`Nova couldn't start Windows PowerShell to reach Outlook: ${e.message}`, 500)));
    child.on('close', () => {
      let answer;
      try { answer = JSON.parse(out.replace(/^﻿/, '')); } catch {
        console.error('Outlook script gave no answer:', (err || out).slice(0, 500));
        return finish(reject, new UserError('Nova couldn\'t read Outlook\'s answer. The details are in Nova\'s log.', 502));
      }
      if (!answer.error) return finish(resolve, answer);
      const known = ERRORS[answer.error];
      if (known) return finish(reject, new UserError(...known));
      console.error('Outlook script failed:', answer.message);
      finish(reject, new UserError(`Outlook refused the request: ${String(answer.message || 'no reason given').slice(0, 300)}`, 502));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export const outlookCom = {
  id: 'outlook-com',
  label: 'Outlook on this computer (COM)',
  available: () => process.platform === 'win32',
  unavailable: 'Outlook on this computer only works when Nova runs on Windows, alongside classic Outlook.',
  list: (limit) => runOutlook({ action: 'list', limit }),
  read: (item) => runOutlook({ action: 'read', entryId: item.entryId, storeId: item.storeId }),
  draftReply: (item, body, replyAll) => runOutlook({ action: 'draft', entryId: item.entryId, storeId: item.storeId, body, replyAll: !!replyAll })
};
