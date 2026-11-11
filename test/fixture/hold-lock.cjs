'use strict';
const {spawn}=require('node:child_process');
module.exports=async function holdLock(directory) {
  const child=spawn('python3',['-B','-c',
    'import sys\nsys.path.insert(0,sys.argv[1])\nimport query_guard\nwith query_guard.single_query_lock():\n print("ready",flush=True)\n sys.stdin.readline()\n',directory],{stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(Error('Fixture lock did not start'));},3000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout.once('data',data=>{clearTimeout(timer);data.toString().trim()==='ready'?resolve():reject(Error('Fixture lock failed'));});
  });
  return ()=>new Promise(resolve=>{child.once('close',resolve);child.stdin.end('\n');});
};
