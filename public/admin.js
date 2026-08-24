const $ = (selector) => document.querySelector(selector);
const state = { csrf: "", issued: [], config: null, selectedDomain: "" };

function flash(message, type = "") {
  const target = $("#adminApp").classList.contains("hidden") ? $("#loginFlash") : $("#adminFlash");
  target.textContent = message || "";
  target.className = `flash ${type}`;
}

async function api(url, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (state.csrf && !["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase())) headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const formatBytes = (value) => {
  let bytes = Number(value || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index += 1; }
  return `${bytes.toFixed(index ? 1 : 0)} ${units[index]}`;
};
const formatDate = (value) => value ? new Date(value).toLocaleString() : "—";
const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

async function establishSession() {
  try {
    const session = await api("/api/admin/session");
    state.csrf = session.csrf || "";
    $("#loginPanel").classList.add("hidden");
    $("#adminApp").classList.remove("hidden");
    state.config = await api("/api/admin/config");
    const domains = (state.config.domains || []).filter((entry) => entry.enabled);
    $("#domainSelect").innerHTML = domains.map((entry) => `<option value="${escapeHtml(entry.domain)}">${escapeHtml(entry.domain)}${entry.default ? " · 默认" : ""}</option>`).join("");
    state.selectedDomain = domains.find((entry) => entry.default)?.domain || domains[0]?.domain || "";
    $("#domainSelect").value = state.selectedDomain;
    $("#domainLabel").textContent = `${state.config.control_host} · MX ${state.config.shared_mx_host}`;
    await refreshAll();
  } catch {
    $("#loginPanel").classList.remove("hidden");
    $("#adminApp").classList.add("hidden");
  }
}

async function refreshDashboard() {
  const value = await api("/api/admin/dashboard");
  $("#mailboxTotal").textContent = value.statistics.mailboxes.total.toLocaleString();
  $("#mailboxEnabled").textContent = value.statistics.mailboxes.enabled.toLocaleString();
  $("#messageTotal").textContent = value.statistics.messages.total.toLocaleString();
  $("#diskUsage").textContent = `${Number(value.disk?.usedPercent || 0).toFixed(1)}%`;
  $("#serviceState").textContent = value.smtp?.ready ? (value.smtp.tls ? "SMTP + TLS" : "SMTP 无 TLS") : "SMTP 未就绪";
  const selected = (value.statistics.domains || []).find((entry) => entry.domain === state.selectedDomain);
  $("#domainLabel").textContent = `${state.config.control_host} · ${state.selectedDomain}${selected ? ` · ${selected.total} 个邮箱` : ""} · MX ${state.config.shared_mx_host}`;
}

async function refreshMailboxes() {
  const search = $("#mailboxSearch").value.trim();
  const value = await api(`/api/admin/mailboxes?limit=1000&domain=${encodeURIComponent(state.selectedDomain)}&search=${encodeURIComponent(search)}`);
  $("#mailboxSummary").textContent = `共 ${value.count.toLocaleString()} 个`;
  $("#mailboxRows").innerHTML = value.items.map((item) => `
    <tr>
      <td>${escapeHtml(item.domain)}</td><td><code>${escapeHtml(item.address)}</code></td>
      <td><span class="badge ${item.enabled ? "on" : "off"}">${item.enabled ? "启用" : "停用"}</span></td>
      <td>${Number(item.message_count || 0).toLocaleString()}</td>
      <td>${formatBytes(item.stored_bytes)}</td>
      <td>${formatDate(item.latest_message_at)}</td>
      <td><div class="row"><button class="btn small ${item.enabled ? "danger" : "success"}" data-toggle="${escapeHtml(item.address)}" data-enabled="${item.enabled ? "1" : "0"}">${item.enabled ? "停用" : "启用"}</button><button class="btn small" data-rotate="${escapeHtml(item.address)}">轮换链接</button></div></td>
    </tr>`).join("") || `<tr><td colspan="7" class="empty">暂无邮箱</td></tr>`;
}

async function refreshMessages() {
  const value = await api(`/api/admin/messages?limit=100&domain=${encodeURIComponent(state.selectedDomain)}`);
  $("#messageRows").innerHTML = value.items.map((item) => `
    <tr data-message="${escapeHtml(item.id)}" style="cursor:pointer">
      <td>${formatDate(item.received_at)}</td><td><code>${escapeHtml(item.recipients)}</code></td>
      <td>${escapeHtml(item.from_text || item.envelope_from)}</td><td>${escapeHtml(item.subject || "(无主题)")}</td><td>${formatBytes(item.raw_size)}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="empty">暂无邮件</td></tr>`;
}

async function refreshAll() {
  await Promise.all([refreshDashboard(), refreshMailboxes(), refreshMessages()]);
}

function showIssued(items) {
  state.issued = items;
  $("#issuedPanel").classList.remove("hidden");
  $("#issuedText").value = items.map((item) => `${item.address}----${item.inbox_url}`).join("\n");
}

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportIssued(format) {
  if (!state.issued.length) return;
  if (format === "json") return download(JSON.stringify(state.issued, null, 2), "mailboxes.json", "application/json");
  if (format === "csv") {
    const rows = ["address,token,inbox_url", ...state.issued.map((item) => [item.address, item.token, item.inbox_url].map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))];
    return download(`\ufeff${rows.join("\n")}`, "mailboxes.csv", "text/csv");
  }
  download(state.issued.map((item) => `${item.address}----${item.inbox_url}`).join("\n"), "mailboxes.txt", "text/plain");
}

async function openMessage(id) {
  const item = await api(`/api/admin/messages/${encodeURIComponent(id)}`);
  $("#dialogSubject").textContent = item.subject || "(无主题)";
  $("#dialogMeta").textContent = `${item.from || "未知发件人"} → ${(item.recipients || []).join(", ")} · ${formatDate(item.date)}`;
  $("#dialogAttachments").innerHTML = [
    `<a class="attachment" href="/api/admin/messages/${encodeURIComponent(id)}/raw">下载原始 EML</a>`,
    ...(item.attachments || []).map((file) => `<a class="attachment" href="/api/admin/messages/${encodeURIComponent(id)}/attachments/${file.index}">${escapeHtml(file.filename)} · ${formatBytes(file.size)}</a>`),
  ].join("");
  const content = $("#dialogContent");
  content.innerHTML = "";
  if (item.html) {
    const frame = document.createElement("iframe"); frame.className = "mail-frame"; frame.setAttribute("sandbox", ""); frame.srcdoc = item.html; content.append(frame);
  } else {
    const pre = document.createElement("div"); pre.className = "mail-text"; pre.textContent = item.text || "(空正文)"; content.append(pre);
  }
  $("#messageDialog").showModal();
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault(); flash("正在登录…");
  try {
    const value = await api("/api/admin/login", { method: "POST", body: JSON.stringify({ username: $("#loginUsername").value, password: $("#loginPassword").value }) });
    state.csrf = value.csrf || ""; $("#loginPassword").value = ""; await establishSession(); flash("");
  } catch (error) { flash(`登录失败：${error.message}`, "error"); }
});

$("#logoutButton").addEventListener("click", async () => { try { await api("/api/admin/logout", { method: "POST" }); } finally { location.reload(); } });
$("#batchForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const value = await api("/api/admin/mailboxes/batch", { method: "POST", body: JSON.stringify({ count: Number($("#batchCount").value), domain: state.selectedDomain }) }); showIssued(value.items); await refreshAll(); flash(`已创建 ${value.count} 个邮箱，请立即导出专属链接。`, "success"); } catch (error) { flash(`创建失败：${error.message}`, "error"); } });
$("#customForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const item = await api("/api/admin/mailboxes", { method: "POST", body: JSON.stringify({ local_part: $("#customLocalPart").value, domain: state.selectedDomain }) }); showIssued([item]); $("#customLocalPart").value = ""; await refreshAll(); flash("邮箱已创建，请立即保存专属链接。", "success"); } catch (error) { flash(`创建失败：${error.message}`, "error"); } });
document.addEventListener("click", async (event) => {
  const exportButton = event.target.closest("[data-export]"); if (exportButton) return exportIssued(exportButton.dataset.export);
  const toggle = event.target.closest("[data-toggle]"); if (toggle) { try { await api(`/api/admin/mailboxes/${encodeURIComponent(toggle.dataset.toggle)}`, { method: "PATCH", body: JSON.stringify({ enabled: toggle.dataset.enabled !== "1" }) }); await refreshAll(); } catch (error) { flash(error.message, "error"); } return; }
  const rotate = event.target.closest("[data-rotate]"); if (rotate) { if (!confirm(`轮换 ${rotate.dataset.rotate} 的访问链接？旧链接将立即失效。`)) return; try { const item = await api(`/api/admin/mailboxes/${encodeURIComponent(rotate.dataset.rotate)}/rotate-token`, { method: "POST" }); showIssued([item]); flash("专属链接已轮换，请立即导出。", "success"); } catch (error) { flash(error.message, "error"); } return; }
  const message = event.target.closest("[data-message]"); if (message) openMessage(message.dataset.message).catch((error) => flash(error.message, "error"));
});
$("#refreshButton").addEventListener("click", refreshAll);
$("#refreshMessages").addEventListener("click", refreshMessages);
$("#domainSelect").addEventListener("change", () => { state.selectedDomain = $("#domainSelect").value; refreshAll().catch((error) => flash(error.message, "error")); });
let searchTimer; $("#mailboxSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(refreshMailboxes, 250); });
$("#closeDialog").addEventListener("click", () => $("#messageDialog").close());
establishSession();
