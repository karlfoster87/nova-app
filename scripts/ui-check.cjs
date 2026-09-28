// Responsive UI check: signs in to a running Nova, fills the chat with every kind of message
// (no prompt is sent), then screenshots each viewport, with the drawers open on narrow ones,
// and reports sideways overflow, overlapping header parts, cut-off pickers and console
// errors. Then it opens Tasks and checks the day window. Chromium for most sizes, WebKit
// (Safari's engine) for one phone.
//
// Playwright isn't a Nova dependency: install it in a scratch folder and point NODE_PATH at
// it. Run it against a throwaway Nova with a test profile, never real data:
//   NODE_PATH=<scratch>/node_modules NOVA_URL=http://127.0.0.1:8585 NOVA_PROFILE=<name>
//   NOVA_PASSWORD=<password> UI_SHOTS=<scratch>/shots node scripts/ui-check.cjs [viewport-name-part]
const { chromium, webkit } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.NOVA_URL || 'http://127.0.0.1:8585';
const OUT = process.env.UI_SHOTS || path.join(os.tmpdir(), 'nova-ui-shots');
const PROFILE = process.env.NOVA_PROFILE, PASSWORD = process.env.NOVA_PASSWORD;
if (!PROFILE || !PASSWORD) { console.error('Set NOVA_PROFILE and NOVA_PASSWORD for a test profile.'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: '1920-desktop', width: 1920, height: 1080 },
  { name: '1680-concept', width: 1680, height: 1000 },
  { name: '1601-just-wide', width: 1601, height: 900 },
  { name: '1600-breakpoint', width: 1600, height: 900 },
  { name: '1440-laptop', width: 1440, height: 900 },
  { name: '1280-laptop', width: 1280, height: 800 },
  { name: '1100-small', width: 1100, height: 800 },
  { name: '1024-tablet-land', width: 1024, height: 768, touch: true },
  { name: '820-tablet', width: 820, height: 1180, touch: true },
  { name: '768-tablet', width: 768, height: 1024, touch: true },
  { name: '390-phone', width: 390, height: 844, touch: true },
  { name: '360-phone', width: 360, height: 740, touch: true },
  { name: '390-phone-webkit', width: 390, height: 844, touch: true, engine: 'webkit' }
];

async function fixture(page) {
  await page.evaluate(async () => {
    const { Transcript } = await import('/render.js');
    const t = new Transcript('x', { onAnswer: () => {}, onChange: () => {} });
    t.addUser('I want to create a cyberpunk anime style image of a girl in a neon city at night.\nCan you suggest a good prompt and workflow for this?', [{ id: '11111111-1111-1111-1111-111111111111', name: 'reference-shot-with-a-long-file-name.png', size: 482113, type: 'image/png' }]);
    t.handleSdk({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Check the brain for saved style notes first.' }, { type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'cyberpunk', path: 'Projects/some/really/long/path/that/keeps/going/and/going/art/styles/' } }] } });
    t.handleSdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Projects/art/styles.md:12: cyberpunk palette' }] } });
    t.handleSdk({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { subagent_type: 'Explore', description: 'Find saved art workflows' } }] } });
    t.handleSdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Two workflows found' }] } });
    t.handleSdk({ type: 'assistant', message: { content: [{ type: 'text', text: "Absolutely. Here's a solid prompt using **Stable Diffusion**.\n\n## Prompt\n\n```\nanime style, cyberpunk city at night, neon lights, rainy streets, young woman with short dark hair, reflective jacket, cinematic composition\n```\n\n## Workflow\n\n1. Use a model like `SDXL` or Pony.\n2. Set CFG to 6.5-8.0, steps 25-40.\n\n| Setting | Value | Notes |\n|---|---|---|\n| Sampler | DPM++ 2M Karras | Stable for anime line work at high step counts |\n| Size | 1024x1536 | Portrait |\n\nSee https://example.com/a/very/long/url/that/should/wrap/instead/of/overflowing/the/column for more." }] } });
    t.handleSdk({ type: 'result', duration_ms: 12400, num_turns: 4, subtype: 'success' });
    t.addUser('Yes please, that would be amazing.');
    t.addPermission({ reqId: 'r1', toolName: 'Write', input: { file_path: 'Projects/art/neon-girl.md' }, canRemember: true, alwaysRules: ['Write(Projects/art/**)'], folder: 'C:\\Notes\\Brain\\Projects' });
    document.getElementById('transcript').replaceChildren(t.el);
    document.getElementById('chatTitle').textContent = 'AI art workflow with a fairly long title for testing';
    document.getElementById('chatWhere').textContent = 'Creative';
    window.dispatchEvent(new CustomEvent('nova:presence', { detail: { state: 'tool', label: 'Running Bash', chatId: 'x', agents: [
      { id: 'a1', name: 'Explore', task: 'Scanning knowledge bases', detail: 'Using Grep', toolUses: 4, startedAt: Date.now() - 42000, state: 'tool' },
      { id: 'a2', name: 'Plan', task: 'Drafting the render plan', detail: '', toolUses: 0, startedAt: Date.now() - 2000, state: 'starting' }],
      recent: [{ id: 'a4', name: 'data-analyst', task: 'Summarising usage', toolUses: 3, startedAt: Date.now() - 60000, endedAt: Date.now() - 5000, state: 'done' }] } }));
  });
}

// Visible elements that stick out past the window, or past the chat header / composer.
async function problems(page) {
  return page.evaluate(() => {
    const out = [];
    const W = innerWidth;
    if (document.documentElement.scrollWidth > W + 1) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${W}`);
    const drawers = [...document.querySelectorAll('.sidebar, .presence')].filter((d) => getComputedStyle(d).position === 'fixed' && !d.classList.contains('open'));
    const label = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
    for (const el of document.querySelectorAll('body *')) {
      if (drawers.some((d) => d.contains(el)) || el.closest('dialog:not([open]), [hidden], .menu')) continue;
      let clip = el.parentElement; // inside something that scrolls or clips sideways, sticking out is fine
      while (clip && clip !== document.body && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement;
      if (clip && clip !== document.body) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.right > W + 1 || r.left < -1) out.push(`${label(el)} outside the window (${Math.round(r.left)}..${Math.round(r.right)} of ${W})`);
    }
    for (const box of document.querySelectorAll('.chat-head, .composer-actions, .appbar')) {
      const b = box.getBoundingClientRect();
      const kids = [...box.children].filter((k) => k.getBoundingClientRect().width);
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        if (r.right > b.right + 1) out.push(`${label(k)} sticks out of ${label(box)}`);
      }
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), c = kids[j].getBoundingClientRect();
        if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) out.push(`${label(kids[i])} overlaps ${label(kids[j])} in ${label(box)}`);
      }
    }
    // The sidebar keeps its width until it becomes a drawer; Recent shows at most three
    // chats and sits pinned just above the footer, under the scrolling list.
    const side = document.querySelector('.sidebar');
    if (getComputedStyle(side).position !== 'fixed' && Math.round(side.getBoundingClientRect().width) !== 280) {
      out.push(`sidebar is ${Math.round(side.getBoundingClientRect().width)}px wide, not 280px`);
    }
    const recentBox = document.getElementById('recentList');
    if (recentBox && !recentBox.hidden && getComputedStyle(side).display !== 'none') {
      if (recentBox.querySelectorAll('.chat-item').length > 3) out.push('Recent shows more than three chats');
      const gap = document.querySelector('.side-foot').getBoundingClientRect().top - recentBox.getBoundingClientRect().bottom;
      if (Math.abs(gap) > 12) out.push(`Recent isn't pinned above the footer (${Math.round(gap)}px gap)`);
    }
    // The pickers share the title's line above 1600px, and sit below the state badge from 1600px down.
    const pickers = document.querySelector('.chat-head .pickers')?.getBoundingClientRect();
    const badge = document.getElementById('chatState')?.getBoundingClientRect();
    if (pickers?.width && badge?.width) {
      const below = pickers.top >= badge.bottom - 1;
      if (W > 1600 && below) out.push('pickers dropped to a second row above 1600px');
      if (W <= 1600 && !below) out.push('pickers not on their own row at 1600px or less');
      const head = document.querySelector('.chat-head'), hs = getComputedStyle(head);
      const inner = head.clientWidth - parseFloat(hs.paddingLeft) - parseFloat(hs.paddingRight);
      if (W <= 1600 && Math.abs(pickers.width - inner) > 4) out.push('second-row pickers don\'t span the header');
    }
    for (const s of document.querySelectorAll('.chat-head select')) {
      if (s.getBoundingClientRect().width && s.scrollWidth > s.clientWidth + 2) out.push(`#${s.id} text is cut off (${s.clientWidth}px)`);
    }
    return [...new Set(out)].slice(0, 25);
  });
}

(async () => {
  const only = process.argv[2];
  const browsers = {};
  let failures = 0;
  for (const vp of VIEWPORTS) {
    if (only && !vp.name.includes(only)) continue;
    const engine = vp.engine || 'chromium';
    browsers[engine] ||= await (engine === 'webkit' ? webkit : chromium).launch();
    const ctx = await browsers[engine].newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: !!vp.touch, isMobile: !!vp.touch && vp.width < 800 && engine !== 'firefox', deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    const login = await ctx.request.post(`${BASE}/api/login`, { data: { name: PROFILE, password: PASSWORD } });
    if (!login.ok()) throw new Error(`sign-in failed: ${login.status()}`);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // WebKit reports Playwright's own screenshot stylesheet being blocked by Nova's CSP; that's expected.
    page.on('console', (m) => { if (m.type() === 'error' && !/Refused to apply a stylesheet/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + '/');
    await page.waitForSelector('#linkState[data-state="online"]', { timeout: 15000 });
    await fixture(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${vp.name}.png`) });
    const found = await problems(page);
    // Drawers on narrow screens. On phones (760px and under) each is the window less a
    // 50px gutter, flush to its own edge, and a tap in the gutter closes it.
    const drawer = async (sel, side) => {
      const r = await page.locator(sel).boundingBox();
      if (vp.width > 760) return;
      if (Math.abs(r.width - (vp.width - 50)) > 1) found.push(`${sel} drawer is ${Math.round(r.width)}px wide, not ${vp.width - 50}px`);
      if (side === 'left' ? Math.abs(r.x) > 1 : Math.abs(r.x + r.width - vp.width) > 1) found.push(`${sel} drawer isn't flush to the ${side} edge`);
    };
    const closedAfterGutterTap = async (sel, x) => {
      await page.mouse.click(x, vp.height / 2);
      await page.waitForTimeout(350);
      if (await page.locator(`${sel}.open`).count()) found.push(`a tap in the gutter doesn't close ${sel}`);
    };
    if (await page.locator('.appbar .menu-btn').isVisible()) {
      await page.locator('.appbar .menu-btn').click();
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(OUT, `${vp.name}-sidebar.png`) });
      await drawer('.sidebar', 'left');
      await closedAfterGutterTap('.sidebar', vp.width - 20);
    }
    if (await page.locator('#presenceBtn').isVisible()) {
      await page.locator('#presenceBtn').click();
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(OUT, `${vp.name}-presence.png`) });
      await drawer('.presence', 'right');
      await closedAfterGutterTap('.presence', 20);
    }
    // Tasks: a window of whole days, two above 1440px and one below, starting on today, and
    // the mouse wheel doesn't move it. Read-only: it adds no tasks.
    await page.goto(BASE + '/#tasks');
    await page.reload();
    if (await page.locator('.task-col').first().waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      await page.waitForTimeout(600);
      const days = () => page.evaluate(() => {
        const b = document.querySelector('.task-board').getBoundingClientRect();
        const rects = [...document.querySelectorAll('.task-col')].map((c) => [c.dataset.day, c.getBoundingClientRect()]);
        return { whole: rects.filter(([, r]) => r.left >= b.left - 1 && r.right <= b.right + 1).map(([d]) => d),
          partial: rects.filter(([, r]) => r.right > b.left + 1 && r.left < b.right - 1 && (r.left < b.left - 1 || r.right > b.right + 1)).length,
          today: document.querySelector('.task-col.today')?.dataset.day };
      });
      const want = vp.width > 1440 ? 2 : 1, before = await days();
      if (before.whole.length !== want || before.partial) found.push(`tasks shows ${before.whole.length} whole and ${before.partial} part day(s), not ${want} whole`);
      if (before.today && before.whole[0] !== before.today) found.push(`tasks opens on ${before.whole[0]}, not today`);
      const box = await page.locator('.task-board').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 60);
      if (!(vp.touch && vp.width < 800)) { // phones have no mouse wheel (mobile WebKit refuses one)
        await page.mouse.wheel(400, 0);
        await page.waitForTimeout(400);
        if ((await days()).whole[0] !== before.whole[0]) found.push('the mouse wheel scrolls the task days');
      }
      await page.screenshot({ path: path.join(OUT, `${vp.name}-tasks.png`) });
      found.push(...(await problems(page)).map((p) => `tasks: ${p}`));
    }
    const all =[...found, ...errors.map((e) => `console: ${e}`)];
    console.log(`\n${vp.name} (${engine}) ${all.length ? 'PROBLEMS' : 'ok'}`);
    for (const p of all) console.log('  - ' + p);
    failures += all.length ? 1 : 0;
    await ctx.close();
  }
  for (const b of Object.values(browsers)) await b.close();
  console.log(failures ? `\n${failures} viewport(s) with problems` : '\nAll viewports clean');
  console.log(`Screenshots: ${OUT}`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
