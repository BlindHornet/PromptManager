/**
 * popup.js
 * Purpose: UI logic for the popup—storage, search, bi-directional Group/Subgroup filters, CRUD, CSV import/export, validation.
 * Storage: OPFS (Origin Private File System) file "prompts.csv" — persisted on disk, offline, no user prompts.
 * Notes: Fully offline. No external libs. Handles thousands of characters and hundreds of items.
 */

const STORAGE_FILENAME = "prompts.csv"; // OPFS file name
const CSV_HEADERS = [
  "ID",
  "Group",
  "Subgroup",
  "Title",
  "Prompt Content",
  "Date Created",
  "Date Modified",
];

// --- DOM Refs
const searchInput = document.getElementById("searchInput");
const groupFilter = document.getElementById("groupFilter");
const subgroupFilter = document.getElementById("subgroupFilter");
const resultCount = document.getElementById("resultCount");
const tbody = document.getElementById("promptTbody");
const emptyState = document.getElementById("emptyState");
const btnNew = document.getElementById("btnNew");
const btnEmptyCreate = document.getElementById("btnEmptyCreate");
const btnExport = document.getElementById("btnExport");
const fileImport = document.getElementById("fileImport");

// Dialog
const promptDialog = document.getElementById("promptDialog");
const promptForm = document.getElementById("promptForm");
const dialogTitle = document.getElementById("dialogTitle");
const groupSelect = document.getElementById("groupSelect");
const groupNew = document.getElementById("groupNew");
const subgroupSelect = document.getElementById("subgroupSelect");
const subgroupNew = document.getElementById("subgroupNew");
const titleInput = document.getElementById("titleInput");
const contentInput = document.getElementById("contentInput");
const promptIdInput = document.getElementById("promptId");
const formError = document.getElementById("formError");
const btnDialogCancel = document.getElementById("btnDialogCancel");
const btnDialogSave = document.getElementById("btnDialogSave");

// Confirm delete
const confirmDialog = document.getElementById("confirmDialog");
const confirmForm = document.getElementById("confirmForm");
const confirmText = document.getElementById("confirmText");
const confirmPromptId = document.getElementById("confirmPromptId");
const btnConfirmCancel = document.getElementById("btnConfirmCancel");

// --- State
let allPrompts = [];
let filtered = [];

// --- Utils
const uuid = () =>
  crypto?.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const sanitize = (s) => (typeof s === "string" ? s.trim() : "");
const nowISO = () => new Date().toISOString();

function toCSV(rows) {
  // RFC 4180-ish quoting: wrap fields containing [",\n,\r] in quotes and double up quotes
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

// Robust CSV parser for quoted fields and commas/newlines
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
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2; // escaped quote
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === ",") {
        pushField();
        i++;
      } else if (char === "\r") {
        i++;
        if (text[i] === "\n") i++;
        pushField();
        pushRow();
      } else if (char === "\n") {
        i++;
        pushField();
        pushRow();
      } else {
        field += char;
        i++;
      }
    }
  }
  pushField();
  if (row.length > 1 || row.some((c) => c !== "")) pushRow();

  return rows;
}

function downloadBlob(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dedupeKey(p) {
  // Prevent duplicate Title within same Group/Subgroup (case-insensitive)
  return `${sanitize(p.group).toLowerCase()}::${sanitize(
    p.subgroup
  ).toLowerCase()}::${sanitize(p.title).toLowerCase()}`;
}

// ===== OPFS (Origin Private File System) I/O =====

async function getOPFSRoot() {
  return await navigator.storage.getDirectory();
}

async function getCSVHandle() {
  const root = await getOPFSRoot();
  try {
    // Try to get; if it doesn't exist, create it
    return await root.getFileHandle(STORAGE_FILENAME, { create: true });
  } catch {
    return await root.getFileHandle(STORAGE_FILENAME, { create: true });
  }
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

// Initialize file on first run (ensure header exists)
async function ensureCSVInitialized() {
  try {
    const txt = await readCSVText();
    if (!txt || !txt.trim()) {
      await writeCSVText(CSV_HEADERS.join(",") + "\r\n");
    } else {
      const header = parseCSV(txt)[0] || [];
      const norm = header.map((h) => h.trim().toLowerCase());
      const expected = CSV_HEADERS.map((h) => h.toLowerCase());
      const ok = expected.every((h, idx) => norm[idx] === h);
      if (!ok) {
        await writeCSVText(CSV_HEADERS.join(",") + "\r\n");
      }
    }
  } catch {
    await writeCSVText(CSV_HEADERS.join(",") + "\r\n");
  }
}

// Convert CSV text to objects
function csvTextToObjects(text) {
  const rows = parseCSV(text);
  if (!rows || rows.length < 2) return [];
  const header = rows[0];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < header.length) continue;
    const [id, group, subgroup, title, content, createdAt, updatedAt] = r;
    if (!title?.trim() || !content?.trim()) continue;
    out.push({
      id: sanitize(id) || uuid(),
      group: sanitize(group),
      subgroup: sanitize(subgroup),
      title: sanitize(title),
      content: sanitize(content),
      createdAt: sanitize(createdAt) || nowISO(),
      updatedAt: sanitize(updatedAt) || nowISO(),
    });
  }
  return out;
}

// ===== Load & Save =====

async function load() {
  await ensureCSVInitialized();
  const csvText = await readCSVText();
  allPrompts = csvTextToObjects(csvText);
  render();
}

async function save() {
  const csv = toCSV(allPrompts);
  await writeCSVText(csv);
}

// ===== Rendering & Filters =====

function buildGroupMaps(items) {
  const groups = new Map();
  for (const p of items) {
    const g = sanitize(p.group) || "(Ungrouped)";
    const s = sanitize(p.subgroup) || "";
    if (!groups.has(g)) groups.set(g, new Set());
    if (s) groups.get(g).add(s);
  }
  return groups;
}

/**
 * Compute dynamic lists based on current selections.
 * - If a Group is selected, Subgroups are restricted to those within that Group.
 * - If a Subgroup is selected, Groups are restricted to those that contain that Subgroup.
 * - If both are selected, both lists remain restricted to the intersection.
 */
function getDynamicLists() {
  const selectedGroup = groupFilter.value; // "" | "(Ungrouped)" | group name
  const selectedSubgroup = subgroupFilter.value; // "" | subgroup

  // Build maps
  const map = buildGroupMaps(allPrompts);

  // All distinct groups (labels)
  const allGroups = [...map.keys()].sort();

  // Helper to get subgroups in a group label
  const subgroupsInGroup = (gLabel) =>
    [...(map.get(gLabel) || new Set())].sort();

  // All distinct subgroups overall
  const allSubgroups = [
    ...new Set([].concat(...allGroups.map((g) => subgroupsInGroup(g)))),
  ].sort();

  // Derive constrained lists
  let groupsList, subgroupsList;

  if (selectedGroup && !selectedSubgroup) {
    // Group selected only → subgroups only from that group; groups remain all to allow switching
    groupsList = allGroups;
    subgroupsList = subgroupsInGroup(selectedGroup);
  } else if (!selectedGroup && selectedSubgroup) {
    // Subgroup selected only → groups that contain that subgroup; subgroups remain all to allow switching
    groupsList = allGroups.filter((g) => map.get(g)?.has(selectedSubgroup));
    subgroupsList = allSubgroups;
  } else if (selectedGroup && selectedSubgroup) {
    // Both selected → intersection: keep groups that contain the subgroup, and subgroups within the group
    groupsList = allGroups.filter((g) => map.get(g)?.has(selectedSubgroup));
    subgroupsList = subgroupsInGroup(selectedGroup);
  } else {
    // None selected
    groupsList = allGroups;
    subgroupsList = allSubgroups;
  }

  return { groupsList, subgroupsList };
}

/**
 * Populate both filters based on current selections and direction.
 * @param {'group'|'subgroup'|null} source  which dropdown triggered the update (to avoid resetting the user's current choice unnecessarily)
 */
function populateFilters(source = null) {
  const prevGroup = groupFilter.value;
  const prevSubgroup = subgroupFilter.value;

  const { groupsList, subgroupsList } = getDynamicLists();

  // Rebuild group options
  groupFilter.innerHTML =
    `<option value="">All Groups</option>` +
    groupsList
      .map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`)
      .join("");

  // Rebuild subgroup options
  subgroupFilter.innerHTML =
    `<option value="">All Subgroups</option>` +
    subgroupsList
      .map(
        (sg) => `<option value="${escapeHtml(sg)}">${escapeHtml(sg)}</option>`
      )
      .join("");

  // Try to preserve previous selections if still valid; otherwise clear them
  if (source !== "subgroup" && prevGroup && !groupsList.includes(prevGroup)) {
    groupFilter.value = ""; // invalid after change
  } else {
    groupFilter.value = prevGroup;
  }

  if (
    source !== "group" &&
    prevSubgroup &&
    !subgroupsList.includes(prevSubgroup)
  ) {
    subgroupFilter.value = ""; // invalid after change
  } else {
    subgroupFilter.value = prevSubgroup;
  }

  // Disable subgroup if no options (besides "All")
  subgroupFilter.disabled = subgroupsList.length === 0;
}

function filterItems() {
  const q = sanitize(searchInput.value).toLowerCase();
  const g = groupFilter.value;
  const sg = subgroupFilter.value;

  filtered = allPrompts
    .filter((p) => {
      const groupLabel = sanitize(p.group) || "(Ungrouped)";
      if (g && groupLabel !== g) return false;
      if (sg && sanitize(p.subgroup) !== sg) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  resultCount.textContent = filtered.length;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderTable() {
  tbody.innerHTML = "";
  for (const p of filtered) {
    const tr = document.createElement("tr");
    tr.tabIndex = 0; // keyboard focusable
    tr.dataset.id = p.id;

    const modified = new Date(
      p.updatedAt || p.createdAt || Date.now()
    ).toLocaleString();

    tr.innerHTML = `
      <td title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</td>
      <td><span class="badge">${escapeHtml(
        p.group || "(Ungrouped)"
      )}</span></td>
      <td>${
        p.subgroup ? `<span class="badge">${escapeHtml(p.subgroup)}</span>` : ""
      }</td>
      <td><span class="muted">${escapeHtml(modified)}</span></td>
      <td>
        <div class="row-actions">
          <button class="btn" data-action="copy" title="Copy content">Copy</button>
          <button class="btn" data-action="edit" title="Edit (Enter)">Edit</button>
          <button class="btn danger" data-action="delete" title="Delete">Delete</button>
        </div>
      </td>
    `;

    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        openEdit(p.id);
      }
      if (e.key === "Delete") {
        e.preventDefault();
        openDelete(p.id);
      }
    });

    tr.querySelector('[data-action="copy"]').addEventListener(
      "click",
      async () => {
        try {
          await navigator.clipboard.writeText(p.content);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = p.content;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
      }
    );
    tr.querySelector('[data-action="edit"]').addEventListener("click", () =>
      openEdit(p.id)
    );
    tr.querySelector('[data-action="delete"]').addEventListener("click", () =>
      openDelete(p.id)
    );

    tbody.appendChild(tr);
  }
}

function render() {
  populateFilters(null);
  filterItems();
  renderTable();
  emptyState.classList.toggle("hidden", allPrompts.length !== 0);
}

// ===== CRUD & Dialogs =====

function openCreate() {
  promptForm.reset();
  dialogTitle.textContent = "New Prompt";
  formError.textContent = "";
  promptIdInput.value = "";

  const groupMap = buildGroupMaps(allPrompts);
  groupSelect.innerHTML =
    `<option value="">(Ungrouped)</option>` +
    [...groupMap.keys()]
      .map((g) => `<option>${escapeHtml(g)}</option>`)
      .join("");
  subgroupSelect.innerHTML = `<option value="">(None)</option>`;
  subgroupSelect.disabled = false;

  groupSelect.value = "";
  subgroupSelect.value = "";

  promptDialog.showModal();
  titleInput.focus();
}

function openEdit(id) {
  const p = allPrompts.find((x) => x.id === id);
  if (!p) return;
  promptForm.reset();
  dialogTitle.textContent = "Edit Prompt";
  formError.textContent = "";
  promptIdInput.value = p.id;

  const groupMap = buildGroupMaps(allPrompts);
  const groups = [...groupMap.keys()];
  if (!groups.includes(p.group || "(Ungrouped)"))
    groups.push(p.group || "(Ungrouped)");
  groupSelect.innerHTML =
    `<option value="">(Ungrouped)</option>` +
    groups
      .map(
        (g) =>
          `<option ${
            g === (p.group || "(Ungrouped)") ? "selected" : ""
          }>${escapeHtml(g)}</option>`
      )
      .join("");

  const subgroups = [...(groupMap.get(p.group || "(Ungrouped)") || new Set())];
  subgroupSelect.innerHTML =
    `<option value="">(None)</option>` +
    subgroups
      .map(
        (sg) =>
          `<option ${sg === (p.subgroup || "") ? "selected" : ""}>${escapeHtml(
            sg
          )}</option>`
      )
      .join("");

  titleInput.value = p.title;
  contentInput.value = p.content;
  groupNew.value = "";
  subgroupNew.value = "";
  promptDialog.showModal();
  titleInput.focus();
}

function openDelete(id) {
  const p = allPrompts.find((x) => x.id === id);
  if (!p) return;
  confirmPromptId.value = p.id;
  confirmText.textContent = `Delete "${p.title}"? This cannot be undone.`;
  confirmDialog.showModal();
}

function resolveGroupAndSubgroup() {
  const g = sanitize(groupNew.value) || sanitize(groupSelect.value) || "";
  const sg =
    sanitize(subgroupNew.value) || sanitize(subgroupSelect.value) || "";
  return { group: g === "(Ungrouped)" ? "" : g, subgroup: sg };
}

function validatePrompt({ id, group, subgroup, title, content }) {
  if (!title) return "Title is required.";
  if (!content) return "Prompt content is required.";
  const targetKey = `${(group || "").toLowerCase()}::${(
    subgroup || ""
  ).toLowerCase()}::${title.toLowerCase()}`;
  for (const p of allPrompts) {
    if (p.id === id) continue;
    const k = `${(p.group || "").toLowerCase()}::${(
      p.subgroup || ""
    ).toLowerCase()}::${p.title.toLowerCase()}`;
    if (k === targetKey)
      return "A prompt with this Title already exists in the same Group/Subgroup.";
  }
  return "";
}

// ===== Events: Filters/Search =====

searchInput.addEventListener("input", () => {
  filterItems();
  renderTable();
});

// Group changed → recompute both dropdowns with source='group'
groupFilter.addEventListener("change", () => {
  populateFilters("group");
  filterItems();
  renderTable();
});

// Subgroup changed → recompute both dropdowns with source='subgroup'
subgroupFilter.addEventListener("change", () => {
  populateFilters("subgroup");
  filterItems();
  renderTable();
});

// ===== Events: New/Edit/Delete =====

btnNew.addEventListener("click", openCreate);
btnEmptyCreate.addEventListener("click", openCreate);

btnExport.addEventListener("click", async () => {
  const csv = toCSV(allPrompts);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  downloadBlob(`prompts-${ts}.csv`, csv);
});

fileImport.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const text = String(reader.result || "");
      const rows = parseCSV(text);
      if (rows.length < 2)
        throw new Error("CSV appears empty or lacks header.");

      const header = rows[0].map((h) => h.trim().toLowerCase());
      const expected = CSV_HEADERS.map((h) => h.toLowerCase());
      const ok = expected.every((h, idx) => header[idx] === h);
      if (!ok) throw new Error("CSV header mismatch. Use the exported format.");

      const existingKeys = new Set(allPrompts.map(dedupeKey));
      let imported = 0;
      for (let i = 1; i < rows.length; i++) {
        const [id, group, subgroup, title, content, createdAt, updatedAt] =
          rows[i];
        const obj = {
          id: sanitize(id) || uuid(),
          group: sanitize(group),
          subgroup: sanitize(subgroup),
          title: sanitize(title),
          content: sanitize(content),
          createdAt: sanitize(createdAt) || nowISO(),
          updatedAt: sanitize(updatedAt) || nowISO(),
        };
        const key = dedupeKey(obj);
        if (!obj.title || !obj.content) continue;
        if (existingKeys.has(key)) continue;
        allPrompts.push(obj);
        existingKeys.add(key);
        imported++;
      }
      await save(); // write to OPFS
      render();
      alert(`Imported ${imported} prompt(s).`);
    } catch (err) {
      alert(`Import failed: ${err.message || err}`);
    } finally {
      fileImport.value = "";
    }
  };
  reader.onerror = () => {
    alert("Failed to read file.");
    fileImport.value = "";
  };
  reader.readAsText(file, "utf-8");
});

btnDialogCancel.addEventListener("click", () => promptDialog.close());
btnConfirmCancel.addEventListener("click", () => confirmDialog.close());

promptForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.textContent = "";

  const id = sanitize(promptIdInput.value) || uuid();
  const { group, subgroup } = resolveGroupAndSubgroup();
  const title = sanitize(titleInput.value);
  const content = sanitize(contentInput.value);

  const err = validatePrompt({ id, group, subgroup, title, content });
  if (err) {
    formError.textContent = err;
    return;
  }

  const existingIndex = allPrompts.findIndex((p) => p.id === id);
  const now = nowISO();

  if (existingIndex >= 0) {
    allPrompts[existingIndex] = {
      ...allPrompts[existingIndex],
      group,
      subgroup,
      title,
      content,
      updatedAt: now,
    };
  } else {
    allPrompts.push({
      id,
      group,
      subgroup,
      title,
      content,
      createdAt: now,
      updatedAt: now,
    });
  }

  try {
    await save(); // persist to OPFS CSV
    promptDialog.close();
    render();
  } catch (err2) {
    formError.textContent = `Save failed: ${err2.message || err2}`;
  }
});

confirmForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = sanitize(confirmPromptId.value);
  const idx = allPrompts.findIndex((p) => p.id === id);
  if (idx >= 0) {
    allPrompts.splice(idx, 1);
    await save(); // persist deletion
    render();
  }
  confirmDialog.close();
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    openCreate();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && promptDialog.open) {
    e.preventDefault();
    btnDialogSave.click();
  }
});

groupSelect.addEventListener("change", () => {
  const g = sanitize(groupSelect.value);
  const actual = g || "(Ungrouped)";
  const map = buildGroupMaps(allPrompts);
  const subs = [...(map.get(actual) || new Set())];
  subgroupSelect.innerHTML =
    `<option value="">(None)</option>` +
    subs.map((s) => `<option>${escapeHtml(s)}</option>`).join("");
  subgroupSelect.disabled = false;
});

tbody.addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr || e.target.closest("button")) return;
  const id = tr.dataset.id;
  if (id) openEdit(id);
});

// Initial load
load();
