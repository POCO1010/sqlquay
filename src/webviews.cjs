'use strict';
const {randomBytes} = require('node:crypto');
const {translator,language}=require('../media/i18n.js');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function document({kind, csp, css, script, i18n, icon, language:locale}, body) {
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="${language(locale)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${esc(csp)}; img-src ${esc(csp)}; script-src 'nonce-${nonce}'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>SQLQuay</title><link rel="stylesheet" href="${esc(css)}"></head><body data-view="${kind}">
${body.replaceAll('{{icon}}', esc(icon))}<script nonce="${nonce}" src="${esc(i18n)}"></script><script nonce="${nonce}" src="${esc(script)}"></script></body></html>`;
}
function connectHtml(assets) {
  const tr=translator(assets.language), h=value=>esc(tr(value));
  return document({...assets,kind:'connect'}, `<main class="connect">
<header class="connect-heading"><img src="{{icon}}" width="42" height="42" alt=""><h1 id="heading">${h("Connect to server")}</h1></header>
<form id="connection">
<div class="name-line"><label>${h("Name")} <input required name="name" maxlength="80" placeholder="${h("Connection name")}"></label><label>${h("Group")} <input name="group" maxlength="80" placeholder="${h("Optional")}"></label><span class="scope">${h("Scope")} <strong>${h("Global")}</strong></span></div>
<fieldset id="methods" class="engines">
<legend>${h("Connection Method")}</legend>
<div role="group" aria-label="${h("Connection method")}">
<label class="engine"><input type="radio" name="channel" value="jdbc" checked> JDBC</label>
<label class="engine"><input type="radio" name="channel" value="dms"> DMS</label>
</div>
</fieldset>
<fieldset id="jdbc-fields">
<section class="engines dialects"><p>${h("Server Type")}</p><div role="group" aria-label="${h("Server type")}"><label class="engine"><input type="radio" name="engine" value="mysql" checked> MySQL</label><label class="engine"><input type="radio" name="engine" value="doris"> Apache Doris / SelectDB</label></div></section>
<div class="config-tabs"><span>${h("Config")}</span><span class="tab active">${h("Main")}</span><span class="subdued">${h("Read-only")}</span></div>
<div class="fields">
<label>${h("Host")} <input required name="host" placeholder="db.example.com" maxlength="253"></label>
<label>${h("Port")} <input required name="port" type="number" min="1" max="65535" value="3306"></label>
<label>${h("Username")} <input required name="user" autocomplete="username" maxlength="256" placeholder="${h("Read-only user")}"></label>
<label>${h("Password")} <input name="password" type="password" autocomplete="current-password" maxlength="1024" placeholder="${h("Password")}"></label>
<label>${h("Database")} <input required name="database" maxlength="128" placeholder="${h("Exact database name")}"></label>
<label>TLS <select name="sslMode" aria-label="TLS">
<option value="VERIFY_IDENTITY">${h("Verify server identity")}</option>
<option value="DISABLED">${h("Disabled (unencrypted)")}</option>
</select></label>
</div>
<p id="tls-warning" class="hint tls-warning" hidden>${h("No TLS: the server is not verified and SQL and results travel unencrypted.")}</p>
</fieldset>
<fieldset id="dms-fields" hidden disabled>
<div class="config-tabs"><span>${h("Config")}</span><span class="tab active">${h("Main")}</span><span class="subdued">${h("Read-only · Aliyun CLI")}</span></div>
<div class="fields">
<label>${h("CLI profile")} <select required name="profile" aria-label="${h("Aliyun CLI profile")}"><option value="">${h("Choose a configured profile")}</option></select></label>
<label>${h("Region")} <input required name="region" aria-label="${h("DMS region")}" maxlength="43" placeholder="cn-hangzhou"></label>
<label>${h("Search keyword")} <input required name="keyword" maxlength="128" placeholder="${h("Keyword used in DMS")}"></label>
<label>${h("Schema")} <input required name="schema" maxlength="128" placeholder="${h("Exact schema name")}"></label>
<label>${h("Database ID")} <input required name="databaseId" inputmode="numeric" pattern="[1-9][0-9]{0,19}" maxlength="20" placeholder="${h("Verified DMS ID")}"></label>
</div>
<p id="dms-auth-status" class="subdued hint" role="status">${h("Choose the named Aliyun CLI profile that can access this DMS database.")}</p>
<div class="form-actions"><button type="button" id="dms-profiles" class="secondary">${h("Refresh profiles")}</button><button type="button" id="dms-auth" class="plain">${h("Configure CLI authentication…")}</button></div>
<p class="subdued hint">${h("DMS authentication stays in Aliyun CLI; SQLQuay does not store its AccessKeys. Production databases only. Configure a named profile in the terminal, then refresh this list.")}</p>
</fieldset>
<div class="form-actions"><button type="submit" name="action" value="save" class="secondary">${h("Save")}</button><button type="submit" name="action" value="connect">＋ ${h("Connect")}</button><button type="button" id="close" class="plain">× ${h("Close")}</button></div>
<p id="feedback" role="status"></p>
</form>
</main>`);
}
function resultHtml(assets) {
  const tr=translator(assets.language), h=value=>esc(tr(value));
  return document({...assets,kind:'result'}, `<main class="result">
<header class="result-tabs"><span class="tab active" id="mode">${h("Data")}</span><span id="target" class="subdued"></span><span class="readonly">${h("Read-only")}</span></header>
<div class="query-line"><textarea id="statement" aria-label="SQL" spellcheck="false" rows="1"></textarea><button id="run" title="${h("Run SQL")}">▶ ${h("Run")}</button></div>
<div class="toolbar" aria-label="${h('Result controls')}">
<button id="pin" class="plain" title="${h("Keep in session history when pinned.")}" aria-pressed="false">${h("Pin result")}</button>
<button id="history" class="plain">${h("Session history")}</button>
<label class="search"><span aria-hidden="true">⌕</span><input id="filter" aria-label="${h("Search Results")}" placeholder="${h("Search Results")}"></label>
<button id="copy" class="plain" title="${h("Copy selected row as TSV")}" disabled>${h("Copy row")}</button>
<span class="separator" aria-hidden="true"></span>
<button id="prev" class="plain step" aria-label="${h("Previous page")}">‹</button><span id="page">1</span><button id="next" class="plain step" aria-label="${h("Next page")}">›</button>
<select id="size" aria-label="${h("Rows per page")}"><option>25</option><option>50</option><option>100</option></select>
<span id="total" title="${h("Filtering, sorting and paging use loaded rows only; they do not query the database again.")}">${esc(tr('Loaded {0} rows',0))}</span><span class="subdued" id="timing"></span>
</div>
<div id="phases" class="subdued" title="${h("Phase times come from the execution wrapper. Other time includes local processing, transfer and cleanup. Only measured values are shown.")}" hidden></div>
<div id="message" role="status" aria-live="polite" hidden></div>
<div class="grid" id="grid"><table aria-label="${h("SQL results")}"><thead></thead><tbody></tbody></table></div>
</main>`);
}
module.exports = {connectHtml,resultHtml};
