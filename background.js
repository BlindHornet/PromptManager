/**
 * background.js (Service Worker)
 * Purpose: Context menu to save selected text as a prompt quickly.
 * Storage: OPFS (Origin Private File System) CSV "prompts.csv" — same file the popup uses.
 */

const STORAGE_FILENAME = "prompts.csv";
const CSV_HEADERS = ["ID","Group","Subgroup","Title","Prompt Content","Date Created","Date Modified"];
const uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const nowISO = () => new Date().toISOString();

// Minimal CSV escape for our use
function toCSV(rows) {
  const escape = (val) => {
    const s = String(val ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push([
      escape(r.id),
      escape(r.group),
      escape(r.subgroup),
      escape(r.title),
      escape(r.content),
      escape(r.createdAt),
      escape(r.updatedAt),
    ].join(","));
  }
  return lines.join("\r\n");
}

function parseCSV(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += char; i++; }
    } else {
      if (char === '"') { inQuotes = true; i++; }
      else if (char === ",") { pushField(); i++; }
      else if (char === "\r") { i++; if (text[i] === "\n") i++; pushField(); pushRow(); }
      else if (char === "\n") { i++; pushField(); pushRow(); }
      else { field += char; i++; }
    }
  }
  pushField();
  if (row.length > 1 || row.some(c => c !== "")) pushRow();
  return rows;
}

async function getOPFSRoot() {
  return await self.navigator.storage.getDirectory();
}
async function getCSVHandle() {
  const root = await getOPFSRoot();
  return await root.getFileHandle(STORAGE_FILENAME, { create: true });
}
async function readCSVText() {
  const handle = await getCSVHandle();
  const file = await handle.getFile();
  return await file.text();
}
async function writeCSVText(text) {
  const handle = await getCSVHandle();
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function ensureCSVInitialized() {
  try {
    const txt = await readCSVText();
    if (!txt || !txt.trim()) {
      await writeCSVText(CSV_HEADERS.join(",") + "\r\n");
    } else {
      const header = parseCSV(txt)[0] || [];
      const norm = header.map(h => h.trim().toLowerCase());
      const expected = CSV_HEADERS.map(h => h.toLowerCase());
      const ok = expected.every((h, idx) => norm[idx] === h);
      if (!ok) await writeCSVText(CSV_HEADERS.join(",") + "\r\n");
    }
  } catch {
    await writeCSVText(CSV_HEADERS.join(",") + "\r\n");
  }
}

function csvTextToObjects(text) {
  const rows = parseCSV(text);
  if (!rows || rows.length < 2) return [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 7) continue;
    const [id, group, subgroup, title, content, createdAt, updatedAt] = r;
    if (!title?.trim() || !content?.trim()) continue;
    out.push({
      id: String(id || "").trim() || uuid(),
      group: String(group || "").trim(),
      subgroup: String(subgroup || "").trim(),
      title: String(title || "").trim(),
      content: String(content || "").trim(),
      createdAt: String(createdAt || "").trim() || nowISO(),
      updatedAt: String(updatedAt || "").trim() || nowISO(),
    });
  }
  return out;
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: "saveSelectionAsPrompt",
    title: "Save selection as Prompt",
    contexts: ["selection"]
  });
  await ensureCSVInitialized();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "saveSelectionAsPrompt" || !info.selectionText) return;

  const content = String(info.selectionText).trim();
  if (!content) return;

  const title = content.length > 80 ? content.slice(0, 77) + "..." : content;

  await ensureCSVInitialized();

  // Read existing, append, write back
  const csvText = await readCSVText();
  const all = csvTextToObjects(csvText);

  const now = nowISO();
  all.push({
    id: uuid(),
    group: "",
    subgroup: "",
    title,
    content,
    createdAt: now,
    updatedAt: now
  });

  const newCSV = toCSV(all);
  await writeCSVText(newCSV);
});
