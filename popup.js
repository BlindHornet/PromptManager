/**
 * popup.js
 * Groups → Subgroups → Items tree, filters, and CRUD dialogs.
 * - Filter selection auto-expands the matching group/subgroup
 * - Create/Edit dialogs list existing groups/subgroups
 * - Rows are clickable to expand/collapse (no separate arrow box)
 * - Highlights text between [brackets] in yellow in contentInput contenteditable div
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

/* ============ CSV helpers ============ */
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
      } else field += ch;
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
  pushField();
  if (row.length) pushRow();
  return rows;
}
function toCSV(items) {
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_HEADERS.join(",")];
  for (const p of items) {
    lines.push(
      [
        escape(p.id),
        escape(p.group),
        escape(p.subgroup),
        escape(p.title),
        escape(p.content),
        escape(p.createdAt),
        escape(p.updatedAt),
      ].join(",")
    );
  }
  return lines.join("\r\n");
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

/* ============ OPFS helpers ============ */
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

/* ============ State & DOM ============ */
let allPrompts = [];
let filteredPrompts = [];

// filters/tree
let searchInput,
  groupFilter,
  subgroupFilter,
  clearFiltersBtn,
  resultCount,
  emptyState,
  treeRoot;
// toolbar
let btnNew, btnEmptyCreate, btnExport, fileImport;
// dialogs
let promptDialog,
  promptForm,
  dialogTitle,
  inputId,
  inputTitle,
  inputContent,
  groupSelect,
  inputGroup,
  subgroupSelect,
  inputSubgroup;
let confirmDialog, confirmForm, confirmTitle, btnDialogCancel, btnConfirmCancel;

/* ============ Utils ============ */
function groupMapFrom(items) {
  const g = new Map();
  for (const p of items) {
    const G = (p.group || "").trim();
    const S = (p.subgroup || "").trim();
    if (!g.has(G)) g.set(G, new Map());
    const sub = g.get(G);
    if (!sub.has(S)) sub.set(S, []);
    const arr = sub.get(S);
    if (Array.isArray(arr)) arr.push(p);
    else sub.set(S, [p]);
  }
  return g;
}
function pathMatchesSearch(items) {
  const q = (searchInput?.value || "").trim().toLowerCase();
  if (!q || !Array.isArray(items)) return false;
  return items.some(
    (it) =>
      (it?.title || "").toLowerCase().includes(q) ||
      (it?.content || "").toLowerCase().includes(q)
  );
}

/* ============ Bracket Highlighting ============ */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function highlightBrackets() {
  if (!inputContent) return;
  const text = inputContent.innerText || "";
  const regex = /\[([^\]]*)\]/g;
  const highlighted = text.replace(regex, (match) => {
    return `<span class="highlight-bracket">${match}</span>`;
  });
  inputContent.innerHTML = highlighted.replace(/\n/g, "<br>");
  // Move cursor to end after updating content
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(inputContent);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ============ Rendering ============ */
function renderTree() {
  const gSel = groupFilter?.value || "";
  const sSel = subgroupFilter?.value || "";

  treeRoot.innerHTML = "";
  const gMap = groupMapFrom(filteredPrompts);
  const groups = Array.from(gMap.keys()).sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { sensitivity: "base" })
  );

  for (const g of groups) {
    const subMap = gMap.get(g);

    const gLi = document.createElement("li");
    gLi.className = "tree-group";
    gLi.setAttribute("role", "treeitem");
    gLi.setAttribute("aria-expanded", "false");

    const gHeader = document.createElement("div");
    gHeader.className = "tree-row group-row";

    const gToggle = document.createElement("button");
    gToggle.className = "toggle";
    gToggle.setAttribute("aria-label", "Expand/Collapse Group");
    gToggle.textContent = "▶";
    gHeader.appendChild(gToggle);

    const gIcon = document.createElement("span");
    gIcon.className = "icon folder";
    gHeader.appendChild(gIcon);

    const gLabel = document.createElement("span");
    gLabel.className = "label";
    gLabel.textContent = g || "(Ungrouped)";
    gHeader.appendChild(gLabel);

    const gNode = document.createElement("ul");
    gNode.className = "children";
    gNode.setAttribute("role", "group");

    gLi.appendChild(gHeader);
    gLi.appendChild(gNode);

    let gExpanded = gSel && g === gSel;
    const allItemsInGroup = Array.from(subMap.values())
      .filter(Array.isArray)
      .flat();
    if (!gExpanded && pathMatchesSearch(allItemsInGroup)) gExpanded = true;

    const subgroups = Array.from(subMap.keys()).sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { sensitivity: "base" })
    );

    for (const s of subgroups) {
      const items = subMap.get(s);

      const sgLi = document.createElement("li");
      sgLi.className = "tree-subgroup";
      sgLi.setAttribute("role", "treeitem");
      sgLi.setAttribute("aria-expanded", "false");

      const sgHeader = document.createElement("div");
      sgHeader.className = "tree-row subgroup-row";

      const sgToggle = document.createElement("button");
      sgToggle.className = "toggle";
      sgToggle.setAttribute("aria-label", "Expand/Collapse Subgroup");
      sgToggle.textContent = "▶";
      sgHeader.appendChild(sgToggle);

      const sgIcon = document.createElement("span");
      sgIcon.className = "icon folder";
      sgHeader.appendChild(sgIcon);

      const sgLabel = document.createElement("span");
      sgLabel.className = "label";
      sgLabel.textContent = s || "(No Subgroup)";
      sgHeader.appendChild(sgLabel);

      const sgNode = document.createElement("ul");
      sgNode.className = "children";
      sgNode.setAttribute("role", "group");

      for (const it of Array.isArray(items) ? items : []) {
        const itLi = document.createElement("li");
        itLi.className = "tree-item";

        const row = document.createElement("div");
        row.className = "tree-row item-row";

        const docIcon = document.createElement("span");
        docIcon.className = "icon doc";
        row.appendChild(docIcon);

        const title = document.createElement("span");
        title.className = "label";
        title.textContent = it.title || "(Untitled)";
        row.appendChild(title);

        const actions = document.createElement("div");
        actions.className = "row-actions";
        const btnCopy = document.createElement("button");
        btnCopy.className = "btn xs";
        btnCopy.textContent = "Copy";
        const btnEdit = document.createElement("button");
        btnEdit.className = "btn xs";
        btnEdit.textContent = "Edit";
        const btnDel = document.createElement("button");
        btnDel.className = "btn xs danger";
        btnDel.textContent = "Delete";
        actions.append(btnCopy, btnEdit, btnDel);
        row.appendChild(actions);

        btnCopy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(it.content || "");
          } catch {}
        });
        btnEdit.addEventListener("click", () => openEdit(it));
        btnDel.addEventListener("click", () => openConfirmDelete(it));

        itLi.appendChild(row);
        sgNode.appendChild(itLi);
      }

      sgLi.appendChild(sgHeader);
      sgLi.appendChild(sgNode);
      gNode.appendChild(sgLi);

      if (
        (gSel && g === gSel && sSel && s === sSel) ||
        pathMatchesSearch(items)
      ) {
        sgLi.setAttribute("aria-expanded", "true");
        sgHeader.classList.add("expanded");
        sgToggle.textContent = "▼";
        gExpanded = true;
      }

      const toggleSg = () => {
        const isOpen = sgLi.getAttribute("aria-expanded") === "true";
        sgLi.setAttribute("aria-expanded", String(!isOpen));
        sgHeader.classList.toggle("expanded", !isOpen);
        sgToggle.textContent = !isOpen ? "▼" : "▶";
      };
      sgToggle.addEventListener("click", toggleSg);
      sgHeader.addEventListener("click", (e) => {
        if (e.target.closest(".row-actions")) return;
        toggleSg();
      });
    }

    if (gExpanded) {
      gLi.setAttribute("aria-expanded", "true");
      gHeader.className = "tree-row group-row expanded";
      gToggle.textContent = "▼";
    }

    const toggleG = () => {
      const isOpen = gLi.getAttribute("aria-expanded") === "true";
      gLi.setAttribute("aria-expanded", String(!isOpen));
      gHeader.classList.toggle("expanded", !isOpen);
      gToggle.textContent = !isOpen ? "▼" : "▶";
    };
    gToggle.addEventListener("click", toggleG);
    gHeader.addEventListener("click", (e) => {
      if (e.target.closest(".row-actions")) return;
      toggleG();
    });

    treeRoot.appendChild(gLi);
  }

  emptyState.classList.toggle("hidden", allPrompts.length !== 0);
}

/* ============ Filters (top of popup) ============ */
function uniqueSorted(arr) {
  return [...new Set(arr)].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { sensitivity: "base" })
  );
}

function rebuildGroupFilter(preserve = true) {
  const prev = preserve ? groupFilter.value || "" : "";
  const groups = uniqueSorted(allPrompts.map((p) => p.group || ""));
  groupFilter.innerHTML =
    `<option value="">All Groups</option>` +
    groups.map((g) => `<option>${g}</option>`).join("");
  if (prev === "" || groups.includes(prev)) groupFilter.value = prev;
  else groupFilter.value = "";
}

function rebuildSubgroupFilter(preserve = true) {
  const gSel = groupFilter.value || "";
  const prev = preserve ? subgroupFilter.value || "" : "";
  const subs = uniqueSorted(
    allPrompts
      .filter((p) => (p.group || "") === gSel)
      .map((p) => p.subgroup || "")
  );
  subgroupFilter.innerHTML =
    `<option value="">All Subgroups</option>` +
    subs.map((s) => `<option>${s}</option>`).join("");
  subgroupFilter.disabled = !gSel;
  if (subs.length && (prev === "" || subs.includes(prev)))
    subgroupFilter.value = prev;
  else subgroupFilter.value = "";
}

function applyFiltersAndRender() {
  const gSel = groupFilter.value || "";
  const sSel = subgroupFilter.value || "";
  const q = (searchInput.value || "").trim().toLowerCase();

  filteredPrompts = allPrompts.filter((p) => {
    if (gSel && (p.group || "") !== gSel) return false;
    if (sSel && (p.subgroup || "") !== sSel) return false;
    if (
      q &&
      !(
        (p.title || "").toLowerCase().includes(q) ||
        (p.content || "").toLowerCase().includes(q)
      )
    )
      return false;
    return true;
  });
  resultCount.textContent = `${filteredPrompts.length}`;
  renderTree();
}

/* ============ Dialog: options ============ */
function dialogPopulateGroups(selected = "") {
  const groups = uniqueSorted(allPrompts.map((p) => p.group || ""));
  groupSelect.innerHTML =
    `<option value="">(New Group… type below)</option>` +
    groups.map((g) => `<option>${g}</option>`).join("");
  groupSelect.value = selected && groups.includes(selected) ? selected : "";
}

function dialogPopulateSubgroups(groupValue, selected = "") {
  const subs = uniqueSorted(
    allPrompts
      .filter((p) => (p.group || "") === (groupValue || ""))
      .map((p) => p.subgroup || "")
  );
  subgroupSelect.innerHTML =
    `<option value="">(New Subgroup… type below)</option>` +
    subs.map((s) => `<option>${s}</option>`).join("");
  subgroupSelect.disabled = !groupValue;
  subgroupSelect.value = selected && subs.includes(selected) ? selected : "";
}

/* ============ CRUD dialog helpers ============ */
function openCreate() {
  dialogTitle.textContent = "New Prompt";
  promptForm.reset();
  inputId.value = "";

  const gSel = groupFilter.value || "";
  dialogPopulateGroups(gSel);
  dialogPopulateSubgroups(gSel, "");

  inputGroup.value = "";
  inputSubgroup.value = "";
  inputContent.innerHTML = "";

  promptDialog.showModal();
  highlightBrackets();
}

function openEdit(p) {
  dialogTitle.textContent = "Edit Prompt";
  inputId.value = p.id;
  inputTitle.value = p.title || "";
  inputContent.innerText = p.content || "";

  dialogPopulateGroups(p.group || "");
  dialogPopulateSubgroups(p.group || "", p.subgroup || "");
  inputGroup.value = "";
  inputSubgroup.value = "";

  promptDialog.showModal();
  highlightBrackets();
}

function openConfirmDelete(p) {
  confirmTitle.textContent = `Delete “${p.title || "(Untitled)"}”?`;
  document.getElementById("confirmPromptId").value = p.id;
  confirmDialog.showModal();
}

/* ============ Load / Save ============ */
async function load() {
  await ensureCSVInitialized();
  const txt = await readCSVText();
  allPrompts = csvTextToObjects(txt);
  rebuildGroupFilter(true);
  rebuildSubgroupFilter(true);
  applyFiltersAndRender();
}
async function save() {
  await writeCSVText(toCSV(allPrompts));
}

/* ============ Events ============ */
function bindEvents() {
  // Filters
  searchInput?.addEventListener("input", applyFiltersAndRender);
  groupFilter?.addEventListener("change", () => {
    rebuildSubgroupFilter(false);
    applyFiltersAndRender();
  });
  subgroupFilter?.addEventListener("change", applyFiltersAndRender);
  clearFiltersBtn?.addEventListener("click", () => {
    groupFilter.value = "";
    rebuildSubgroupFilter(false);
    applyFiltersAndRender();
  });

  // Toolbar
  btnNew?.addEventListener("click", openCreate);
  btnEmptyCreate?.addEventListener("click", openCreate);
  btnExport?.addEventListener("click", async () => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const blob = new Blob([toCSV(allPrompts)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `prompts-${ts}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
  fileImport?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const imported = csvTextToObjects(text);
    const map = new Map(allPrompts.map((p) => [p.id, p]));
    for (const p of imported)
      map.set(p.id || crypto.randomUUID(), { ...map.get(p.id), ...p });
    allPrompts = Array.from(map.values());
    await save();
    rebuildGroupFilter(true);
    rebuildSubgroupFilter(true);
    applyFiltersAndRender();
    e.target.value = "";
  });

  // Dialog buttons
  btnDialogCancel?.addEventListener("click", () => promptDialog.close());
  btnConfirmCancel?.addEventListener("click", () => confirmDialog.close());

  // Forms
  promptForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = inputId.value || crypto.randomUUID();
    const now = new Date().toISOString();
    const existingIdx = allPrompts.findIndex((p) => p.id === id);
    const obj = {
      id,
      title: inputTitle.value.trim(),
      content: inputContent.innerText,
      group: (inputGroup.value || groupSelect.value || "").trim(),
      subgroup: (inputSubgroup.value || subgroupSelect.value || "").trim(),
      createdAt: existingIdx >= 0 ? allPrompts[existingIdx].createdAt : now,
      updatedAt: now,
    };
    if (existingIdx >= 0) allPrompts[existingIdx] = obj;
    else allPrompts.push(obj);

    await save();
    promptDialog.close();
    rebuildGroupFilter(true);
    rebuildSubgroupFilter(true);
    applyFiltersAndRender();
  });

  confirmForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("confirmPromptId").value;
    allPrompts = allPrompts.filter((p) => p.id !== id);
    await save();
    confirmDialog.close();
    rebuildGroupFilter(true);
    rebuildSubgroupFilter(true);
    applyFiltersAndRender();
  });

  // Dialog interactivity: when changing dialog group, update dialog subgroup
  groupSelect?.addEventListener("change", () => {
    if (groupSelect.value) inputGroup.value = "";
    dialogPopulateSubgroups(groupSelect.value || "", "");
  });

  // Bracket highlighting for contentInput
  inputContent?.addEventListener("input", highlightBrackets);

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      openCreate();
    }
    if (e.key === "Escape") {
      if (promptDialog?.open) promptDialog.close();
      if (confirmDialog?.open) confirmDialog.close();
    }
  });
}

/* ============ Bootstrap ============ */
document.addEventListener("DOMContentLoaded", () => {
  // filters/tree
  searchInput = document.getElementById("searchInput");
  groupFilter = document.getElementById("groupFilter");
  subgroupFilter = document.getElementById("subgroupFilter");
  clearFiltersBtn = document.getElementById("clearFilters");
  resultCount = document.getElementById("resultCount");
  emptyState = document.getElementById("emptyState");
  treeRoot = document.getElementById("treeRoot");

  // toolbar
  btnNew = document.getElementById("btnNew");
  btnEmptyCreate = document.getElementById("btnEmptyCreate");
  btnExport = document.getElementById("btnExport");
  fileImport = document.getElementById("fileImport");

  // dialogs
  promptDialog = document.getElementById("promptDialog");
  promptForm = document.getElementById("promptForm");
  dialogTitle = document.getElementById("dialogTitle");
  inputId = document.getElementById("promptId");
  inputTitle = document.getElementById("titleInput");
  inputContent = document.getElementById("contentInput");
  groupSelect = document.getElementById("groupSelect");
  inputGroup = document.getElementById("groupNew");
  subgroupSelect = document.getElementById("subgroupSelect");
  inputSubgroup = document.getElementById("subgroupNew");

  confirmDialog = document.getElementById("confirmDialog");
  confirmForm = document.getElementById("confirmForm");
  confirmTitle = document.getElementById("confirmTitle");
  btnDialogCancel = document.getElementById("btnDialogCancel");
  btnConfirmCancel = document.getElementById("btnConfirmCancel");

  // Initialize highlighting
  if (inputContent) {
    highlightBrackets();
  }

  bindEvents();
  load();
});
