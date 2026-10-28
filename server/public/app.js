// Daily Goals web client. No build step: plain ES modules talking to /api.

const $ = (sel) => document.querySelector(sel);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const SECTIONS = [
  { key: "overdue", label: "Carried over", horizon: null },
  { key: "day", label: "Today", horizon: "day" },
  { key: "week", label: "This week", horizon: "week" },
  { key: "month", label: "This month", horizon: "month" },
  { key: "year", label: "This year", horizon: "year" },
  { key: "someday", label: "Someday", horizon: "someday" },
];
const PROVIDER_LABELS = { "google-calendar": "Calendar", trello: "Planyway", capture: "Thought" };

let state = { date: null, today: null, agenda: null };

// ---------- API ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${store.get("token", "")}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    openSettings("Enter your app token to continue.");
    throw new ApiError(401, "unauthorized");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data;
}

// ---------- rendering ----------

function formatDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function periodLabel(section, agenda) {
  const p = agenda.periods;
  switch (section.key) {
    case "day": return agenda.date === agenda.today ? "Today" : formatDate(agenda.date);
    case "week": return `Week of ${new Date(`${p.week}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    case "month": return new Date(`${p.month}T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    case "year": return p.year.slice(0, 4);
    default: return section.label;
  }
}

function render() {
  const { agenda } = state;
  if (!agenda) return;
  $("#date-title").textContent = agenda.date === agenda.today ? `Today · ${formatDate(agenda.date)}` : formatDate(agenda.date);
  $("#go-today").hidden = agenda.date === agenda.today;

  const root = $("#sections");
  root.replaceChildren();
  for (const section of SECTIONS) {
    const tasks = agenda[section.key];
    if (section.key === "overdue" && (!tasks.length || agenda.date !== agenda.today)) continue;
    if (section.key === "someday" && !tasks.length) continue;

    const card = document.createElement("section");
    card.className = `card section ${section.key}`;
    const h = document.createElement("h2");
    h.textContent = periodLabel(section, agenda);
    const count = document.createElement("span");
    count.className = "muted";
    const done = tasks.filter((t) => t.done).length;
    count.textContent = tasks.length ? `${done}/${tasks.length}` : "";
    h.append(count);
    card.append(h);

    const list = document.createElement("ul");
    list.className = "tasks";
    for (const t of tasks) list.append(renderTask(t, section));
    if (!tasks.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Nothing yet.";
      card.append(p);
    }
    card.append(list);
    if (section.horizon) card.append(renderAddRow(section.horizon));
    root.append(card);
  }
}

function renderTask(task, section) {
  const li = $("#task-tpl").content.firstElementChild.cloneNode(true);
  li.classList.toggle("done", task.done);
  const box = li.querySelector("input");
  box.checked = task.done;
  box.addEventListener("change", () => toggle(task, box.checked));
  li.querySelector(".title").textContent = task.title;
  if (task.notes) li.querySelector(".title").title = task.notes;

  const meta = li.querySelector(".meta");
  const bits = [];
  if (task.startTime) bits.push(task.startTime);
  if (section.key === "overdue" && task.periodStart) bits.push(task.periodStart);
  meta.textContent = bits.join(" · ");
  for (const source of new Set([task.source, ...task.linkedTo])) {
    const label = PROVIDER_LABELS[source] ?? (source === "app" ? null : source);
    if (!label) continue;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = label;
    meta.append(badge);
  }
  li.querySelector(".more").addEventListener("click", () => openEditor(li, task));
  return li;
}

function renderAddRow(horizon) {
  const row = document.createElement("form");
  row.className = "add-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Add a task";
  input.setAttribute("aria-label", `Add a ${horizon} task`);
  const btn = document.createElement("button");
  btn.textContent = "Add";
  row.append(input, btn);
  row.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    btn.disabled = true;
    try {
      await api("/tasks", { method: "POST", body: { title, horizon, date: state.agenda.date } });
      input.value = "";
      await refresh();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  return row;
}

function openEditor(li, task) {
  if (li.nextElementSibling?.classList.contains("editor")) {
    li.nextElementSibling.remove();
    return;
  }
  const form = document.createElement("form");
  form.className = "editor";
  form.innerHTML = `
    <input name="title" type="text" aria-label="Title">
    <textarea name="notes" rows="2" placeholder="Notes" aria-label="Notes"></textarea>
    <div class="add-row">
      <select name="horizon" aria-label="When">
        <option value="day">Day</option><option value="week">Week</option>
        <option value="month">Month</option><option value="year">Year</option><option value="someday">Someday</option>
      </select>
      <input name="date" type="date" aria-label="Date">
      <input name="startTime" type="time" aria-label="Time">
    </div>
    <div class="buttons">
      <button type="button" class="danger" data-act="delete">Delete</button>
      <button type="button" data-act="tomorrow">Tomorrow</button>
      <button class="primary">Save</button>
    </div>`;
  // form.elements, not form.title: HTMLFormElement has its own `title` property.
  const f = form.elements;
  f.title.value = task.title;
  f.notes.value = task.notes;
  f.horizon.value = task.horizon;
  f.date.value = task.periodStart ?? state.agenda.date;
  f.startTime.value = task.startTime ?? "";
  const wrapper = document.createElement("li");
  wrapper.className = "editor";
  wrapper.append(form);
  li.after(wrapper);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const horizon = f.horizon.value;
    await saveTask(task.id, {
      title: f.title.value,
      notes: f.notes.value,
      horizon,
      ...(horizon === "someday" ? {} : { date: f.date.value }),
      startTime: horizon === "day" && f.startTime.value ? f.startTime.value : null,
    });
  });
  form.addEventListener("click", async (e) => {
    const act = e.target.dataset?.act;
    if (act === "delete" && confirm(`Delete “${task.title}”?`)) {
      await api(`/tasks/${task.id}`, { method: "DELETE" });
      await refresh();
    } else if (act === "tomorrow") {
      const d = new Date(`${state.today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      await saveTask(task.id, { horizon: "day", date: d.toISOString().slice(0, 10) });
    }
  });
}

async function saveTask(id, patch) {
  try {
    await api(`/tasks/${id}`, { method: "PATCH", body: patch });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

async function toggle(task, done) {
  try {
    await api(`/tasks/${task.id}`, { method: "PATCH", body: { done } });
  } catch (err) {
    alert(err.message);
  }
  await refresh();
}

async function refresh() {
  const query = state.date ? `?date=${state.date}` : "";
  try {
    state.agenda = await api(`/agenda${query}`);
    state.today = state.agenda.today;
    store.set("agendaCache", state.agenda);
  } catch (err) {
    if (err.status === 401) return;
    state.agenda ??= store.get("agendaCache", null); // offline: show the last copy
  }
  render();
}

function shiftDay(delta) {
  const base = state.agenda?.date ?? state.today;
  if (!base) return;
  const d = new Date(`${base}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  state.date = d.toISOString().slice(0, 10);
  refresh();
}

// ---------- capture ----------

const status = (msg) => { $("#capture-status").textContent = msg; };

function showResult(result) {
  const list = $("#capture-result");
  list.replaceChildren();
  const summary = document.createElement("li");
  summary.textContent = result.summary;
  list.append(summary);
  const verbs = { create: "Added", complete: "Checked off", reopen: "Reopened", reschedule: "Moved", update: "Updated" };
  for (const op of result.applied) {
    const li = document.createElement("li");
    const b = document.createElement("b");
    b.textContent = op.title;
    const when = op.periodStart ? `${op.horizon} of ${op.periodStart}` : op.horizon;
    li.append(`${op.skipped ? "Skipped" : verbs[op.action]} `, b, op.skipped ? ` (${op.skipped})` : ` → ${when}`);
    list.append(li);
  }
}

async function sendCapture(text, capturedAt) {
  return api("/captures", { method: "POST", body: { text, capturedAt } });
}

async function submitCapture() {
  const box = $("#capture-text");
  const text = box.value.trim();
  if (!text) return;
  const capturedAt = new Date().toISOString();
  $("#capture-send").disabled = true;
  status("Thinking…");
  try {
    const result = await sendCapture(text, capturedAt);
    box.value = "";
    store.set("captureDraft", "");
    status("");
    showResult(result);
    await refresh();
    loadCaptures();
  } catch (err) {
    if (err instanceof ApiError) {
      status(err.message);
    } else {
      // Network failure: keep the thought and send it when we're back online.
      const queue = store.get("captureQueue", []);
      queue.push({ text, capturedAt });
      store.set("captureQueue", queue);
      box.value = "";
      store.set("captureDraft", "");
      status(`Offline. Saved ${queue.length} thought${queue.length > 1 ? "s" : ""}; it will be processed when you're back online.`);
    }
  } finally {
    $("#capture-send").disabled = false;
  }
}

async function flushQueue() {
  const queue = store.get("captureQueue", []);
  if (!queue.length || !navigator.onLine) return;
  const remaining = [];
  for (const item of queue) {
    try {
      const result = await sendCapture(item.text, item.capturedAt);
      showResult(result);
    } catch (err) {
      // Server-side failures are recorded with the capture; only retry network errors.
      if (!(err instanceof ApiError)) remaining.push(item);
    }
  }
  store.set("captureQueue", remaining);
  status(remaining.length ? `${remaining.length} thought(s) still waiting to send.` : "");
  await refresh();
  loadCaptures();
}

function setupDictation() {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) return;
  const mic = $("#mic");
  const box = $("#capture-text");
  mic.hidden = false;
  let rec = null;
  let base = "";
  mic.addEventListener("click", () => {
    if (rec) { rec.stop(); return; }
    rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language;
    base = box.value ? `${box.value.trim()} ` : "";
    rec.onresult = (e) => {
      let text = "";
      for (const r of e.results) text += r[0].transcript;
      box.value = base + text;
      store.set("captureDraft", box.value);
    };
    rec.onerror = (e) => status(`Dictation error: ${e.error}`);
    rec.onend = () => { rec = null; mic.classList.remove("listening"); status(""); };
    rec.start();
    mic.classList.add("listening");
    status("Listening… tap the mic to stop.");
  });
}

async function loadCaptures() {
  try {
    const captures = await api("/captures");
    const list = $("#captures-list");
    list.replaceChildren();
    for (const c of captures) {
      const li = document.createElement("li");
      li.textContent = c.text;
      const meta = document.createElement("span");
      meta.className = "muted";
      const when = new Date(c.createdAt).toLocaleString();
      meta.textContent = c.result ? `${when} · ${c.result.summary}` : c.error ? `${when} · Failed: ${c.error}` : `${when} · Not processed`;
      li.append(meta);
      list.append(li);
    }
  } catch { /* offline */ }
}

// ---------- settings ----------

function openSettings(message) {
  const dlg = $("#settings");
  $("#token").value = store.get("token", "");
  if (message) $("#token").placeholder = message;
  if (!dlg.open) dlg.showModal();
  loadSyncState();
}

async function loadSyncState() {
  if (!store.get("token", "")) return;
  try {
    const s = await api("/sync");
    const g = s.google;
    const btn = $("#google-btn");
    if (!g?.available) {
      $("#google-state").textContent = "Not set up on the server";
      btn.hidden = true;
    } else {
      $("#google-state").textContent = g.connected ? "Connected" : "Not connected";
      btn.hidden = false;
      btn.textContent = g.connected ? "Disconnect" : "Connect";
      btn.onclick = async () => {
        if (g.connected) {
          await api("/google/disconnect", { method: "POST" });
          loadSyncState();
        } else {
          const { url } = await api("/google/connect", { method: "POST" });
          location.href = url;
        }
      };
    }
    const last = s.last;
    const errors = last?.providers.flatMap((p) => p.errors) ?? [];
    $("#sync-state").textContent = !s.providers.length
      ? "No apps connected"
      : last
        ? `${s.providers.map((p) => PROVIDER_LABELS[p] ?? p).join(", ")} · last ${new Date(last.finishedAt).toLocaleTimeString()}${errors.length ? ` · ${errors.length} error(s): ${errors[0]}` : ""}`
        : "Not run yet";
  } catch { /* handled by api() */ }
}

// ---------- boot ----------

$("#prev").addEventListener("click", () => shiftDay(-1));
$("#next").addEventListener("click", () => shiftDay(1));
$("#go-today").addEventListener("click", () => { state.date = null; refresh(); });
$("#open-settings").addEventListener("click", () => openSettings());
$("#save-settings").addEventListener("click", () => {
  store.set("token", $("#token").value.trim());
  refresh();
  loadCaptures();
  flushQueue();
});
$("#sync-now").addEventListener("click", async () => {
  $("#sync-state").textContent = "Syncing…";
  await api("/sync", { method: "POST" }).catch(() => {});
  await loadSyncState();
  refresh();
});
$("#capture-send").addEventListener("click", submitCapture);
$("#capture-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitCapture();
});
$("#capture-text").addEventListener("input", (e) => store.set("captureDraft", e.target.value));
$("#capture-text").value = store.get("captureDraft", "");
window.addEventListener("online", flushQueue);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

setupDictation();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (new URLSearchParams(location.search).has("google")) history.replaceState(null, "", "/");

if (!store.get("token", "")) openSettings("Enter the APP_TOKEN from your server");
else { refresh(); loadCaptures(); flushQueue(); }
