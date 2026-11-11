'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createVSIX}=require('@vscode/vsce'),manifest=require('../package.json');
const root=path.resolve(__dirname,'..'),output=path.join(root,'artifacts','sqlquay-'+manifest.version+'.vsix');
fs.mkdirSync(path.dirname(output),{recursive:true});
createVSIX({cwd:root,packagePath:output,dependencies:false}).catch(error=>{console.error(error.message);process.exitCode=1;});
