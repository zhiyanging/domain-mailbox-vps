const $ = (selector) => document.querySelector(selector);
const state = { address: "", items: [], selected: "" };
const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString() : "—";
const formatBytes = (value) => { let bytes = Number(value || 0), index = 0; const units = ["B", "KB", "MB", "GB"]; while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index += 1; } return `${bytes.toFixed(index ? 1 : 0)} ${units[index]}`; };

async function api(url) {
  const response = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function flash(value, type = "") { $("#inboxFlash").textContent = value || ""; $("#inboxFlash").className = `flash ${type}`; }

async function loadSession() {
  const expected = decodeURIComponent(location.pathname.split("/").pop() || "");
  const session = await api(`/api/inbox/session?address=${encodeURIComponent(expected)}`);
  state.address = session.address;
  $("#inboxAddress").textContent = state.address;
  document.title = `${state.address} · 收件箱`;
}

async function loadMessages(keepSelection = true) {
  const value = await api(`/api/inbox/messages?address=${encodeURIComponent(state.address)}&limit=200`);
  state.items = value.items || [];
  $("#mailCount").textContent = `${value.count || 0} 封 · 永久保留`;
  $("#mailItems").innerHTML = state.items.map((item) => `
    <button class="mail-item ${item.id === state.selected ? "active" : ""}" data-id="${escapeHtml(item.id)}">
      <div class="mail-item-title">${escapeHtml(item.subject || "(无主题)")}</div>
      <div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.from_text || item.source || "未知发件人")}</div>
      <div class="mail-item-meta"><span>${formatDate(item.created_at)}</span><span>${formatBytes(item.raw_size)}</span></div>
    </button>`).join("") || `<div class="empty">暂无邮件，页面会自动刷新。</div>`;
  if (!keepSelection && state.items[0]) await openMessage(state.items[0].id);
}

async function openMessage(id) {
  state.selected = id;
  document.querySelectorAll(".mail-item").forEach((item) => item.classList.toggle("active", item.dataset.id === id));
  $("#mailContent").innerHTML = `<div class="empty">正在读取邮件…</div>`;
  const item = await api(`/api/inbox/messages/${encodeURIComponent(id)}?address=${encodeURIComponent(state.address)}`);
  $("#mailSubject").textContent = item.subject || "(无主题)";
  $("#mailMeta").textContent = `${item.from || "未知发件人"} · ${formatDate(item.date)}`;
  const content = $("#mailContent"); content.innerHTML = "";
  const links = document.createElement("div");
  links.innerHTML = [
    `<a class="attachment" href="/api/inbox/messages/${encodeURIComponent(id)}/raw?address=${encodeURIComponent(state.address)}">下载原始 EML</a>`,
    ...(item.attachments || []).map((file) => `<a class="attachment" href="/api/inbox/messages/${encodeURIComponent(id)}/attachments/${file.index}?address=${encodeURIComponent(state.address)}">${escapeHtml(file.filename)} · ${formatBytes(file.size)}</a>`),
  ].join("");
  content.append(links);
  if (item.html) { const frame = document.createElement("iframe"); frame.className = "mail-frame section"; frame.setAttribute("sandbox", ""); frame.srcdoc = item.html; content.append(frame); }
  else { const text = document.createElement("div"); text.className = "mail-text section"; text.textContent = item.text || "(空正文)"; content.append(text); }
}

$("#mailItems").addEventListener("click", (event) => { const item = event.target.closest("[data-id]"); if (item) openMessage(item.dataset.id).catch((error) => flash(error.message, "error")); });
$("#refreshInbox").addEventListener("click", () => loadMessages().catch((error) => flash(error.message, "error")));

try { await loadSession(); await loadMessages(false); setInterval(() => loadMessages().catch(() => {}), 5000); }
catch (error) { flash(`专属链接已失效或邮箱已停用：${error.message}`, "error"); $("#mailItems").innerHTML = `<div class="empty">请重新打开管理员提供的专属链接。</div>`; }
