'use strict';
const {app}=require('electron'),fs=require('node:fs'),path=require('node:path'),v8=require('node:v8');
const directory=process.argv[2];
if(!/^E:[\\/]Dev[\\/]Outputs[\\/]MangohanaV2-20261111[\\/]tests[\\/]stage17-v8-[A-Za-z0-9]{6}[\\/](default|scoped)$/.test(directory))throw Error('Unexpected probe directory');
for(const key of ['userData','sessionData','temp','home','documents']){
  const local=path.join(directory,key);fs.mkdirSync(local,{recursive:true});app.setPath(key,local);
}
app.whenReady().then(()=>{
  fs.writeFileSync(path.join(directory,'observed.json'),JSON.stringify({electron:process.versions.electron,v8:process.versions.v8,
    jsFlags:app.commandLine.getSwitchValue('js-flags'),cacheTag:v8.cachedDataVersionTag()}),{flag:'wx'});
  app.quit();
});
