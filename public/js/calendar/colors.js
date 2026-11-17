// Calendar colours, in a leaf module (it imports only lib/dom.js) so Settings can use them while
// the app is still loading, without waiting on the shell's import cycle. The names match server
// calendar/calendars.js COLORS; calendar.css maps each to a colour token.
import { h } from '../lib/dom.js';

export const COLORS = [['cyan', 'Cyan'], ['pink', 'Pink'], ['violet', 'Violet'], ['amber', 'Amber'], ['green', 'Green'], ['red', 'Red']];

// A calendar's colour swatch.
export const dot = (cal) => h('span', { class: `cal-dot cal-c-${cal?.color || 'cyan'}`, 'aria-hidden': 'true' });
