'use strict';
const fs=require('node:fs'),path=require('node:path');
function validateIcon(data) {
  if(data.length<24 || data.toString('hex',0,8)!=='89504e470d0a1a0a') throw Error('Marketplace icon must be a PNG image.');
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
  if(width<128 || height<128 || width>1024 || height>1024) throw Error('Marketplace icon dimensions must be between 128 and 1024 pixels.');
  return {width,height};
}
if(require.main===module) {
  const {createVSIX}=require('@vscode/vsce'),manifest=require('../package.json');
  const root=path.resolve(__dirname,'..'),output=path.join(root,'artifacts','sqlquay-'+manifest.version+'.vsix');
  validateIcon(fs.readFileSync(path.join(root,manifest.icon)));
  fs.mkdirSync(path.dirname(output),{recursive:true});
  createVSIX({cwd:root,packagePath:output,dependencies:false}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={validateIcon};
