'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'), manifest=require('../package.json');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dbw-vsix-'));
const ext=path.join(temp,'extension');
const output=path.join(root,'artifacts','sqlquay-'+manifest.version+'.vsix');
const staged=path.join(temp,'package.vsix');
try {
  fs.mkdirSync(path.join(ext,'build','jdbc'),{recursive:true});
  fs.mkdirSync(path.join(ext,'scripts'));
  execFileSync('javac',['-encoding','UTF-8','-d',path.join(ext,'build','jdbc'),path.join(root,'scripts','WorkbenchJdbc.java')],{stdio:'inherit'});
  for (const entry of ['package.json','README.md','CHANGELOG.md','src','media','docs','scripts/jdbc_guard.py','scripts/preview_safe.py','scripts/dms_timed.py']) fs.cpSync(path.join(root,entry),path.join(ext,entry),{recursive:true});
  fs.writeFileSync(path.join(temp,'extension.vsixmanifest'),`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}"/>
<DisplayName>${manifest.displayName}</DisplayName><Description xml:space="preserve">${manifest.description}</Description><Categories>Other</Categories>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>`);
  const types={json:'application/json',cjs:'application/javascript',js:'application/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',md:'text/markdown',py:'text/plain',class:'application/octet-stream',vsixmanifest:'text/xml'};
  fs.writeFileSync(path.join(temp,'[Content_Types].xml'),`<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${Object.entries(types).map(([suffix,type])=>`<Default Extension="${suffix}" ContentType="${type}"/>`).join('')}</Types>`);
  execFileSync('zip',['-q','-r',staged,'[Content_Types].xml','extension.vsixmanifest','extension'],{cwd:temp});
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.copyFileSync(staged,output);
  console.log(output);
} finally {fs.rmSync(temp,{recursive:true,force:true});}
