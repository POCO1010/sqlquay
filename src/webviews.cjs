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
<header class="connect-heading"><img src="{{icon}}" width="42" height="42" alt=""><h1 id="heading">${h("Connect to server")}</h1><span class="connection-status subdued">${h("Read-only")}</span></header>
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
<section class="engines dialects"><p>${h("Server Type")}</p><div role="group" aria-label="${h("Server type")}"><label class="engine"><input type="radio" name="engine" value="mysql" checked> MySQL</label><label class="engine"><input type="radio" name="engine" value="polardb"> PolarDB MySQL</label><label class="engine"><input type="radio" name="engine" value="drds"> PolarDB-X / DRDS</label><label class="engine"><input type="radio" name="engine" value="doris"> Apache Doris / SelectDB</label></div></section>
<div class="fields">
<label>${h("Host")} <input required name="host" placeholder="db.example.com" maxlength="253"></label>
<label>${h("Port")} <input required name="port" type="number" min="1" max="65535" value="3306"></label>
<label>${h("Username")} <input required name="user" autocomplete="username" maxlength="256" placeholder="${h("Read-only user")}"></label>
<label>${h("Password")} <input name="password" type="password" autocomplete="current-password" maxlength="1024" placeholder="${h("Password")}"></label>
<label>${h("Database")} <input required name="database" maxlength="128" placeholder="${h("Exact database name")}"></label>
<label>${h('Environment label')} <select name="jdbcEnvironment"><option value="">${h('Unmarked')}</option><option value="product">${h('Production')}</option><option value="test">${h('Test')}</option><option value="dev">${h('Development')}</option><option value="pre">${h('Pre-release')}</option><option value="sit">SIT</option><option value="uat">UAT</option><option value="pet">${h('Load test')}</option><option value="stag">${h('Staging')}</option></select></label>
<label>TLS <select name="sslMode" aria-label="TLS">
<option value="VERIFY_IDENTITY">${h("Verify server identity")}</option>
<option value="DISABLED">${h("Disabled (unencrypted)")}</option>
</select></label>
</div>
<p id="tls-warning" class="hint tls-warning" hidden>${h("No TLS: the server is not verified and SQL and results travel unencrypted.")}</p>
</fieldset>
<fieldset id="dms-fields" hidden disabled>
<div class="fields">
<label>${h('Authentication')} <select name="authMode" aria-label="${h('DMS authentication')}"><option value="accessKey">${h('AccessKey (recommended)')}</option><option value="profile">${h('Existing CLI profile (advanced)')}</option></select></label>
<label>${h("Region")} <input required name="region" aria-label="${h("DMS region")}" maxlength="43" value="cn-hangzhou" placeholder="cn-hangzhou"></label>
</div>
<fieldset id="dms-ak-fields">
<p class="hint"><button type="button" id="dms-ak-guide" class="plain">${h('Get AccessKey…')}</button> <span class="subdued">${h('Sign in as a RAM user with DMS query permission and create an AccessKey. Do not use the main account.')}</span></p>
<div class="fields hint">
<label>AccessKey ID <input name="accessKeyId" type="password" autocomplete="off" maxlength="256" placeholder="${h('Paste AccessKey ID')}"></label>
<label>AccessKey Secret <input name="accessKeySecret" type="password" autocomplete="off" maxlength="256" placeholder="${h('Paste AccessKey Secret')}"></label>
</div>
<p class="subdued hint" id="dms-ak-status">${h('Keys stay in VS Code SecretStorage; no CLI account setup is required.')}</p>
</fieldset>
<fieldset id="dms-database-picker" class="hint">
<div class="database-picker"><label for="dms-database-input">${h('Instance')}</label><div id="dms-database-control">
<input id="dms-database-input" name="keyword" type="search" maxlength="128" autocomplete="off" aria-describedby="dms-search-status" placeholder="${h('Instance name (optional)')}">
<button type="button" id="dms-search" class="secondary">${h('Find')}</button>
</div></div>
<div class="catalog-filters hint"><label>${h('Environment')} <select id="dms-environment-filter"><option value="">${h('All environments')}</option><option value="product">${h('Production')}</option><option value="test">${h('Test')}</option><option value="dev">${h('Development')}</option><option value="pre">${h('Pre-release')}</option><option value="sit">SIT</option><option value="uat">UAT</option><option value="pet">${h('Load test')}</option><option value="stag">${h('Staging')}</option></select></label>
<label>${h('Engine')} <select id="dms-engine-filter"><option value="">${h('All engines')}</option><option value="mysql">MySQL</option><option value="polardb">PolarDB MySQL</option><option value="drds">PolarDB-X / DRDS</option><option value="selectdb">SelectDB</option><option value="doris">Doris</option><option value="ots">Tablestore</option></select></label></div>
<div id="dms-instance-results" class="hint" hidden><div id="dms-instances" role="group" aria-label="${h('Instances')}"></div><button id="dms-more-instances" type="button" class="secondary" hidden>${h('Load more instances')}</button></div>
<div id="dms-search-results" class="hint" hidden><p id="dms-instance-title" class="hint"></p><p id="dms-capability" class="subdued hint" hidden>${h('Tablestore: databases, tables and DDL only.')}</p><div id="dms-instance-search" class="instance-search"><input id="dms-database-filter" type="search" maxlength="128" placeholder="${h('Filter database names')}" aria-label="${h('Filter database names')}"><button id="dms-filter-databases" type="button" class="secondary">${h('Find databases')}</button></div><label class="database-option"><input type="checkbox" id="dms-select-all">${h('Select current page')}</label><div id="dms-database-options" role="group" aria-label="${h('Matching databases')}"></div><button id="dms-more-databases" type="button" class="secondary" hidden>${h('Load more databases')}</button></div>
<div id="dms-selected" class="hint" hidden><p id="dms-selection-count" class="subdued" role="status"></p><ul id="dms-selected-databases" aria-label="${h('Selected databases')}"></ul></div>
<p id="dms-removal-status" class="subdued hint" role="status" hidden></p>
<p id="dms-search-status" class="subdued hint" role="status">${h('Find instances, then expand one to choose databases. Leave the instance name blank to list all.')}</p>
</fieldset>
<fieldset id="dms-profile-fields" hidden disabled>
<div class="fields hint">
<label>${h("CLI profile")} <select required name="profile" aria-label="${h("Aliyun CLI profile")}"><option value="">${h("Choose a configured profile")}</option></select></label>
<label>${h('Engine')} <select name="dmsEngine"><option value="">${h('Detect from DMS')}</option><option value="mysql">MySQL / RDS MySQL</option><option value="polardb">PolarDB MySQL</option><option value="drds">PolarDB-X / DRDS</option><option value="selectdb">SelectDB</option><option value="doris">Doris</option><option value="ots">Tablestore</option></select></label>
<label>${h("Environment")} <select name="environment"><option value="product">${h("Production")}</option><option value="test">${h("Test")}</option><option value="dev">${h("Development")}</option><option value="pre">${h("Pre-release")}</option><option value="sit">SIT</option><option value="uat">UAT</option><option value="pet">${h("Load test")}</option><option value="stag">${h("Staging")}</option></select></label>
<label>${h("Schema")} <input required name="schema" maxlength="128" placeholder="${h("Exact schema name")}"></label>
<label>${h("Database ID")} <input required name="databaseId" inputmode="numeric" pattern="[1-9][0-9]{0,19}" maxlength="20" placeholder="${h("Verified DMS ID")}"></label>
</div>
<details id="dms-search-options" class="hint"><summary>${h('Advanced matching')}</summary>
<div class="fields hint"><label>${h('DMS search name (optional)')} <input name="searchHint" maxlength="128" placeholder="${h('Leave blank to use the database name')}"></label></div>
<p class="subdued hint">${h('Only needed if DMS finds this database under a different name.')}</p></details>
<p id="dms-auth-status" class="subdued hint" role="status">${h("Choose the named Aliyun CLI profile that can access this DMS database.")}</p>
<div class="form-actions"><button type="button" id="dms-profiles" class="secondary">${h("Refresh profiles")}</button><button type="button" id="dms-auth" class="plain">${h("Configure CLI authentication…")}</button></div>
</fieldset>
</fieldset>
<div class="form-actions"><button type="submit" name="action" value="save" class="secondary">${h("Save")}</button><button type="submit" name="action" value="connect">＋ ${h("Connect")}</button><button type="button" id="close" class="plain">× ${h("Close")}</button></div>
<p id="feedback" role="status"></p>
</form>
</main>`);
}
function resultHtml(assets) {
  const tr=translator(assets.language), h=value=>esc(tr(value));
  return document({...assets,kind:'result'}, `<main class="result">
<header class="result-tabs"><span class="tab active" id="mode">${h("Data")}</span><span id="environment-badge" class="target-badge" hidden></span><span id="channel-badge" class="target-badge" hidden></span><span id="tls-badge" class="target-badge warning" hidden>${h('Unencrypted')}</span><div class="target-context"><span id="target" class="subdued"></span><span id="target-instance" class="subdued" hidden></span><span id="target-database" hidden></span></div><span class="readonly">${h("Read-only")}</span></header>
<div class="query-line"><textarea id="statement" aria-label="SQL" spellcheck="false" rows="1"></textarea><button id="run" title="${h("Run SQL")}">▶ ${h("Run")}</button></div>
<div class="toolbar" aria-label="${h('Result controls')}">
<button id="pin" class="plain" title="${h("Keep in session history when pinned.")}" aria-pressed="false">${h("Pin result")}</button>
<button id="history" class="plain">${h("Session history")}</button>
<label class="search"><span aria-hidden="true">⌕</span><input id="filter" aria-label="${h("Search Results")}" placeholder="${h("Search Results")}"></label>
<button id="copy-selection" class="plain" title="${h('Click a cell; Shift+click selects a range. Cmd/Ctrl+C copies.')}" disabled>${h('Copy cell')}</button>
<button id="view-value" class="plain" title="${h('Double-click a cell to view its full value.')}" disabled>${h('View value')}</button>
<span id="selection-status" class="subdued" role="status"></span>
<button id="copy" class="plain" title="${h("Copy selected row as TSV")}" disabled>${h("Copy row")}</button>
<span class="separator" aria-hidden="true"></span>
<button id="prev" class="plain step" aria-label="${h("Previous page")}">‹</button><span id="page">1</span><button id="next" class="plain step" aria-label="${h("Next page")}">›</button>
<select id="size" aria-label="${h("Rows per page")}"><option>25</option><option>50</option><option>100</option></select>
<span id="total" title="${h("Filtering, sorting and paging use loaded rows only; they do not query the database again.")}">${esc(tr('Loaded {0} rows',0))}</span><span class="subdued" id="timing"></span>
</div>
<div id="phases" class="subdued" title="${h("Phase times come from the execution wrapper. Other time includes local processing, transfer and cleanup. Only measured values are shown.")}" hidden></div>
<div id="message" role="status" aria-live="polite" hidden></div>
<div id="diagnostic" class="subdued" role="note" hidden></div>
<div class="result-content"><div class="grid" id="grid"><table role="grid" aria-multiselectable="true" aria-label="${h("SQL results")}"><thead></thead><tbody></tbody></table></div>
<aside id="cell-detail" aria-label="${h('Cell details')}" hidden><header><strong id="cell-heading"></strong><button id="copy-value" class="plain">${h('Copy value')}</button><button id="close-value" class="plain" aria-label="${h('Close cell details')}">×</button></header><pre id="cell-value" tabindex="0"></pre></aside></div>
</main>`);
}
module.exports = {connectHtml,resultHtml};
