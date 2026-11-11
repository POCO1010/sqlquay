'use strict';
const {randomBytes} = require('node:crypto');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function document({kind, csp, css, script, icon}, body) {
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${esc(csp)}; img-src ${esc(csp)}; script-src 'nonce-${nonce}'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>SQLQuay</title><link rel="stylesheet" href="${esc(css)}"></head><body data-view="${kind}">
${body.replaceAll('{{icon}}', esc(icon))}<script nonce="${nonce}" src="${esc(script)}"></script></body></html>`;
}
function connectHtml(assets) {
  return document({...assets,kind:'connect'}, `<main class="connect">
<header class="connect-heading"><img src="{{icon}}" width="42" height="42" alt=""><h1 id="heading">Connect to server</h1></header>
<form id="connection">
<div class="name-line"><label>Name <input required name="name" maxlength="80" placeholder="Connection name"></label><label>Group <input name="group" maxlength="80" placeholder="Optional"></label><span class="scope">Scope <strong>Global</strong></span></div>
<fieldset id="methods" class="engines">
<legend>Connection Method</legend>
<div role="group" aria-label="Connection method">
<label class="engine"><input type="radio" name="channel" value="jdbc" checked> JDBC</label>
<label class="engine"><input type="radio" name="channel" value="dms"> DMS</label>
</div>
</fieldset>
<fieldset id="jdbc-fields">
<section class="engines dialects"><p>Server Type</p><div role="group" aria-label="Server type"><label class="engine"><input type="radio" name="engine" value="mysql" checked> MySQL</label><label class="engine"><input type="radio" name="engine" value="doris"> Apache Doris / SelectDB</label></div></section>
<div class="config-tabs"><span>Config</span><span class="tab active">Main</span><span class="subdued">Read-only</span></div>
<div class="fields">
<label>Host <input required name="host" placeholder="db.example.com" maxlength="253"></label>
<label>Port <input required name="port" type="number" min="1" max="65535" value="3306"></label>
<label>Username <input required name="user" autocomplete="username" maxlength="256" placeholder="Read-only user"></label>
<label>Password <input name="password" type="password" autocomplete="current-password" maxlength="1024" placeholder="Password"></label>
<label>Database <input required name="database" maxlength="128" placeholder="Exact database name"></label>
<label>TLS <select name="sslMode" aria-label="TLS">
<option value="VERIFY_IDENTITY">Verify server identity</option>
<option value="DISABLED">Disabled (unencrypted)</option>
</select></label>
</div>
<p id="tls-warning" class="hint tls-warning" hidden>No TLS: the server is not verified and SQL and results travel unencrypted.</p>
</fieldset>
<fieldset id="dms-fields" hidden disabled>
<div class="config-tabs"><span>Config</span><span class="tab active">Main</span><span class="subdued">Read-only · dms-prod</span></div>
<div class="fields">
<label>Search keyword <input required name="keyword" maxlength="128" placeholder="Keyword used in DMS"></label>
<label>Schema <input required name="schema" maxlength="128" placeholder="Exact schema name"></label>
<label>Database ID <input required name="databaseId" inputmode="numeric" pattern="[1-9][0-9]{0,19}" maxlength="20" placeholder="Verified DMS ID"></label>
</div>
<p class="subdued hint">Use a verified product-environment target. This connection uses the local DMS CLI profile and needs no database password.</p>
</fieldset>
<div class="form-actions"><button type="submit" name="action" value="save" class="secondary">Save</button><button type="submit" name="action" value="connect">＋ Connect</button><button type="button" id="close" class="plain">× Close</button></div>
<p id="feedback" role="status"></p>
</form>
</main>`);
}
function resultHtml(assets) {
  return document({...assets,kind:'result'}, `<main class="result">
<header class="result-tabs"><span class="tab active" id="mode">DATA</span><span id="target" class="subdued"></span><span class="readonly">READ ONLY</span></header>
<div class="query-line"><textarea id="statement" aria-label="SQL" spellcheck="false" rows="1"></textarea><button id="run" title="Run SQL">▶ Run</button></div>
<div class="toolbar" aria-label="Result controls">
<button id="pin" class="plain" title="固定后保留在会话历史中" aria-pressed="false">固定结果</button>
<button id="history" class="plain">会话历史</button>
<label class="search"><span aria-hidden="true">⌕</span><input id="filter" aria-label="Search Results" placeholder="Search Results"></label>
<button id="copy" class="plain" title="Copy selected row as TSV" disabled>Copy row</button>
<span class="separator" aria-hidden="true"></span>
<button id="prev" class="plain step" aria-label="Previous page">‹</button><span id="page">1</span><button id="next" class="plain step" aria-label="Next page">›</button>
<select id="size" aria-label="Rows per page"><option>25</option><option>50</option><option>100</option></select>
<span id="total" title="筛选、排序和翻页仅针对已加载行，不会重新查询数据库。">已加载 0 行</span><span class="subdued" id="timing"></span>
</div>
<div id="phases" class="subdued" title="连接与预检来自执行封装；其他包含本地处理、传输和清理。仅显示本次实测值。" hidden></div>
<div id="message" role="status" aria-live="polite" hidden></div>
<div class="grid" id="grid"><table aria-label="SQL results"><thead></thead><tbody></tbody></table></div>
</main>`);
}
module.exports = {connectHtml,resultHtml};
