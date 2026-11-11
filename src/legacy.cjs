'use strict';
const vscode=require('vscode'),{sendLegacy}=require('./migration.cjs');
exports.activate=context=>({migrate:token=>sendLegacy(context,vscode,token)});
