'use strict';
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const rules=[
  ['private home path', /\/(?:Users|home)\/[^\s/"'`]+/],
  ['private policy path', /\.codex\/skills\/[^\s/"'`]+/],
  ['private network address', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['cloud database endpoint', /\b[\w.-]+\.(?:rds|mysql)\.aliyuncs\.com\b/],
  ['access token or key', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|LTAI[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['email address', /\b[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];
function issues(text,file='') {
  const found=[],passwordLabel=['"Password"','"密码",'].join(': ');
  for(const [index,line] of text.split(/\r?\n/).entries()) {
    for(const [kind,pattern] of rules)if(pattern.test(line))found.push({line:index+1,kind});
    for(const m of line.matchAll(/\bpassword["']?\s*[:=]\s*(["'])([^"'\r\n]*)\1/gi)) {
      if(file==='media/i18n.js' && line.trim()===passwordLabel) continue;
      if(!['','fixture','fixture-secret','synthetic','ignored'].includes(m[2]))found.push({line:index+1,kind:'literal password'});
    }
  }
  return found;
}
if(require.main===module) {
  const root=path.resolve(__dirname,'..');
  const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  if(!files.length)throw Error('No tracked files to inspect. Stage the intended release files first.');
  let failures=0;
  for(const file of files) {
    const data=fs.readFileSync(path.join(root,file));
    if(data.includes(0))continue;
    for(const issue of issues(data.toString('utf8'),file)) {
      console.error(`${file}:${issue.line}: ${issue.kind}`);failures++;
    }
  }
  if(failures)process.exitCode=1;
  else console.log(`PUBLIC_CONTENT_CHECK_PASS (${files.length} tracked files; screenshots require visual review)`);
}
module.exports={issues};
