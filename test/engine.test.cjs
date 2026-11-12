'use strict';
const {test}=require('node:test'),{execFileSync}=require('node:child_process'),path=require('node:path');
test('engine identity, all environments, DRDS scan gate, Tablestore metadata boundary and shared lock',()=>{execFileSync('python3',['-I','-B',path.join(__dirname,'engine-fixture.py')],{stdio:'pipe'});});
