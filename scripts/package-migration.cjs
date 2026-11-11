'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createVSIX}=require('@vscode/vsce');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'sqlquay-legacy-'));
const manifest={name:'database-workbench',publisher:'local-workbench',displayName:'SQLQuay Legacy Migration Helper',description:'Local-only bridge from the former Workbench identity to TomMajor.sqlquay.',version:'0.4.1',license:'MIT',engines:{vscode:'^1.96.0'},categories:['Other'],main:'./src/legacy.cjs',activationEvents:[],sqlquayMigrationHelper:true,files:['src/**','README.md','LICENSE'],repository:require('../package.json').repository};
(async()=>{
 try {
  fs.mkdirSync(path.join(temp,'src'));
  for(const name of ['legacy.cjs','migration.cjs','jdbc.cjs','dms.cjs','query.cjs']) fs.copyFileSync(path.join(root,'src',name),path.join(temp,'src',name));
  fs.copyFileSync(path.join(root,'LICENSE'),path.join(temp,'LICENSE'));
  fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify(manifest,null,2));
  fs.writeFileSync(path.join(temp,'README.md'),'# Local migration helper\n\nDo not upload this helper to Marketplace. Install it locally instead of the old Workbench, then install SQLQuay and run SQLQuay: 从旧版 Workbench 导入连接和当前工作区绑定. Connections and secrets stay on this machine. Legacy data is not deleted.\n');
  const output=path.join(root,'artifacts','sqlquay-legacy-migration-0.4.1.vsix');fs.mkdirSync(path.dirname(output),{recursive:true});
  await createVSIX({cwd:temp,packagePath:output,dependencies:false});
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
