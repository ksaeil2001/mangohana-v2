'use strict';
// Installed before loading any runtime. Electron's owned renderer processes are
// kernel Job members; Node subprocess/model/network entry points always throw.
function installTypesettingBoundaries(counter={network:0,otherProcess:0}){
 const deny=kind=>()=>{counter[kind]++;throw Object.assign(Error('TYPESETTING_ONLY_FORBIDDEN_'+kind),{code:'TYPESETTING_ONLY_AI_CALL_FORBIDDEN'});};
 for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[method]=deny('otherProcess');
 globalThis.fetch=deny('network');for(const name of ['node:http','node:https'])for(const method of ['get','request'])require(name)[method]=deny('network');require('node:net').Socket.prototype.connect=deny('network');require('node:tls').connect=deny('network');require('node:dgram').createSocket=deny('network');require('node:module').syncBuiltinESMExports();return counter;
}
module.exports={installTypesettingBoundaries};
