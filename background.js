/**
 * background.js (Service Worker)
 * Purpose: Context menu to save selected text as a prompt quickly.
 * Storage: OPFS (Origin Private File System) CSV "prompts.csv" — same file the popup uses.
 */

const STORAGE_FILENAME = "prompts.csv";
const CSV_HEADERS = [
  "ID",
  "Group",
  "Subgroup",
  "Title",
  "Prompt Content",
  "Date Created",
  "Date Modified",
];
const uuid = () =>
  crypto?.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
    lines.push(
      [
        escape(r.id),
        escape(r.group),
        escape(r.subgroup),
        escape(r.title),
        escape(r.content),
        escape(r.createdAt),
        escape(r.updatedAt),
      ].join(",")
    );
  }
  return lines.join("\r\n");
}

// CSV parse (very small, adequate for our headers)
function parseCSV(text) {
  const rows = [];
  let i = 0,
    field = "",
    row = [],
    inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i++];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === ",") pushField();
      else if (ch === "\n") {
        pushField();
        pushRow();
      } else if (ch === "\r") {
        /* ignore */
      } else if (ch === '"') inQuotes = true;
      else field += ch;
    }
  }
  // flush last
  pushField();
  if (row.length) pushRow();
  return rows;
}

async function getOPFSFileHandle() {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(STORAGE_FILENAME, { create: true });
}
async function readCSVText() {
  const handle = await getOPFSFileHandle();
  const file = await handle.getFile();
  return await file.text();
}
async function writeCSVText(text) {
  const handle = await getOPFSFileHandle();
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}
async function ensureCSVInitialized() {
  try {
    const txt = await readCSVText();
    if (!txt || !txt.trim()) {
      await writeCSVText(CSV_HEADERS.join(",") + "\r\n");
    } else {
      const header = (parseCSV(txt)[0] || []).map((h) =>
        h.trim().toLowerCase()
      );
      const expected = CSV_HEADERS.map((h) => h.toLowerCase());
      const ok = expected.every((h, i) => header[i] === h);
      if (!ok) await writeCSVText(CSV_HEADERS.join(",") + "\r\n");
    }
  } catch {
    await writeCSVText(CSV_HEADERS.join(",") + "\r\n");
  }
}

function csvTextToObjects(text) {
  const rows = parseCSV(text);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.length || r.every((c) => !c || !String(c).trim())) continue;
    out.push({
      id: r[0] ?? "",
      group: r[1] ?? "",
      subgroup: r[2] ?? "",
      title: r[3] ?? "",
      content: r[4] ?? "",
      createdAt: r[5] ?? "",
      updatedAt: r[6] ?? "",
    });
  }
  return out;
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.contextMenus.removeAll();
  } catch (e) {}
  chrome.contextMenus.create(
    {
      id: "saveSelectionAsPrompt",
      title: "Save selection as Prompt",
      contexts: ["selection"],
    },
    () => {
      // Swallow duplicate errors in dev reloads
      if (chrome.runtime.lastError) {
        /* no-op */
      }
    }
  );
  await ensureCSVInitialized();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "saveSelectionAsPrompt" || !info.selectionText)
    return;

  const content = String(info.selectionText).trim();
  if (!content) return;

  const title = content.length > 80 ? content.slice(0, 77) + "…" : content;

  const txt = await readCSVText();
  const all = csvTextToObjects(txt);

  const now = nowISO();
  all.push({
    id: uuid(),
    group: "",
    subgroup: "",
    title,
    content,
    createdAt: now,
    updatedAt: now,
  });

  const newCSV = toCSV(all);
  await writeCSVText(newCSV);
});
