'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'sqlquay-native-'));
const profile=path.join(temp,'profile'),fixture=path.join(temp,'legacy'),workspace=path.join(temp,'workspace'),result=path.join(temp,'result.json');
for(const dir of [path.join(profile,'User'),fixture,workspace]) fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(profile,'User','settings.json'),JSON.stringify({'workbench.startupEditor':'none','security.workspace.trust.enabled':false,'extensions.autoUpdate':false,'extensions.autoCheckUpdates':false,'telemetry.telemetryLevel':'off','update.mode':'none'}));
fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'database-workbench',publisher:'local-workbench',version:'0.4.2',engines:{vscode:'^1.96.0'},main:'./legacy.cjs',activationEvents:[],sqlquayMigrationHelper:true}));
fs.copyFileSync(path.join(__dirname,'fixture','legacy-host.cjs'),path.join(fixture,'legacy.cjs'));
const binary=process.env.DBW_CODE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const child=spawnSync(binary,['--user-data-dir='+profile,'--extensions-dir='+path.join(temp,'extensions'),'--extensionDevelopmentPath='+root,'--extensionDevelopmentPath='+fixture,'--extensionTestsPath='+path.join(__dirname,'migration-host.cjs'),'--skip-welcome','--skip-release-notes','--disable-updates','--use-mock-keychain',workspace],{env:{...process.env,DBW_PROJECT_ROOT:root,DBW_HOST_RESULT:result},encoding:'utf8',timeout:75000,maxBuffer:4*1024*1024});
if(fs.existsSync(result) && JSON.parse(fs.readFileSync(result)).status==='passed' && child.status===0) {
 console.log('SQLQUAY_NATIVE_MIGRATION_PASS '+fs.readFileSync(result));fs.rmSync(temp,{recursive:true,force:true});
} else {
 console.error('Native migration did not pass. Fixture directory: '+temp);
 if(fs.existsSync(result)) console.error(fs.readFileSync(result,'utf8'));
 if(fs.existsSync(result+'.progress')) console.error(fs.readFileSync(result+'.progress','utf8'));
 console.error('status='+child.status+' signal='+child.signal+' '+(child.error?.message??''));
 console.error(child.stderr?.slice(-1800)??'');process.exitCode=1;
}
