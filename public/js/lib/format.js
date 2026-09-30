// Numbers and dates as the page writes them.

// "1 byte", "12 KB", "3.4 MB".
export const fileSize = (b) => (b < 1024 ? `${b} ${b === 1 ? 'byte' : 'bytes'}` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

// A local calendar day as 'YYYY-MM-DD', so "today" follows this device's clock, not the server's.
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
