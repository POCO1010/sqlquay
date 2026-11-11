'use strict';
const vscode=require('vscode'),{sendLegacy}=require('./migration.cjs');
exports.activate=context=>({migrationVersion:2,migrate:(token,options)=>sendLegacy(context,vscode,token,options)});
