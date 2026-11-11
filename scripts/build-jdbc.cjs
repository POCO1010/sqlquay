'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),output=path.join(root,'build','jdbc');
const check=spawnSync('javac',['-version'],{encoding:'utf8'});
if(check.error || check.status!==0) throw Error('A JDK 8+ compiler is required to package SQLQuay.');
const version=check.stdout+check.stderr;
const modern=!/\b1\.8\b/.test(version);
fs.mkdirSync(output,{recursive:true});
execFileSync('javac',[...(modern?['--release','8']:['-source','8','-target','8']),'-encoding','UTF-8','-d',output,path.join(__dirname,'WorkbenchJdbc.java')],{stdio:'inherit'});
