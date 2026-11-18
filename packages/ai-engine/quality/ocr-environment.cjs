'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const policies=new WeakSet();
const fail=()=>Object.assign(new Error('OCR private E environment policy is invalid'),{code:'CONFIG_PATH'});
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;

/** Server-owned paths only. This never reads or modifies the caller's process.env. */
async function prepareOcrEnvironmentPolicy({pythonExecutable,profileRoot}){
 if(typeof pythonExecutable!=='string'||!path.isAbsolute(pythonExecutable)||typeof profileRoot!=='string'||!path.isAbsolute(profileRoot)||!/^E:[\\/]/i.test(profileRoot))throw fail();
 const python=path.resolve(pythonExecutable),profile=path.resolve(profileRoot),home=path.join(profile,'ocr-home');
 const [pythonStat,profileStat]=await Promise.all([fs.lstat(python),fs.lstat(profile)]);
 if(!pythonStat.isFile()||pythonStat.isSymbolicLink()||!profileStat.isDirectory()||profileStat.isSymbolicLink()||!same(await fs.realpath(python),python)||!same(await fs.realpath(profile),profile))throw fail();
 await fs.mkdir(home,{recursive:true});const homeStat=await fs.lstat(home);if(!homeStat.isDirectory()||homeStat.isSymbolicLink()||!same(await fs.realpath(home),home))throw fail();
 const version='ocr-private-home-v1',identity=Object.freeze({version,python,home});const policy=Object.freeze({version,pythonExecutable:python,home,identity});policies.add(policy);return policy;
}

function applyOcrSpawnEnvironment(executable,options,policy){
 if(!policies.has(policy))throw fail();
 if(typeof executable!=='string'||!same(path.resolve(executable),policy.pythonExecutable))return options;
 if(!options||typeof options!=='object'||!Object.hasOwn(options,'env')||!options.env||typeof options.env!=='object'||Array.isArray(options.env))return options;
 const env={};for(const key of Object.keys(options.env))if(!['HOME','USERPROFILE'].includes(key.toUpperCase()))env[key]=options.env[key];
 env.HOME=policy.home;env.USERPROFILE=policy.home;return {...options,env};
}
module.exports={prepareOcrEnvironmentPolicy,applyOcrSpawnEnvironment};
