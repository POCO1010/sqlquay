'use strict';
const {test}=require('node:test'),{execFileSync}=require('node:child_process'),path=require('node:path');
test('bundled policy preserves scan gates, lock isolation and partial AI-mode cleanup',()=>{execFileSync('python3',['-I','-B',path.join(__dirname,'policy-fixture.py')],{stdio:'pipe'});});
