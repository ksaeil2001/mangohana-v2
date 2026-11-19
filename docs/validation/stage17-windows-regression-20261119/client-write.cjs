// Parent-only observer. Never saves the request headers, bearer value or body.
const dc=require('node:diagnostics_channel'),fs=require('node:fs'),path=require('node:path');
if(process.env.NODE_TEST_CONTEXT && path.basename(process.argv[1]||'')==='engine-runtime-reuse.test.mjs' && process.env.STAGE17_WIRE_PATH){
  const requests=new WeakMap(),sockets=new WeakMap(),origins=new Set(),rows=[];
  let nextRequest=0,nextSocket=0;
  const emit=(event,fields)=>rows.push({at:new Date().toISOString(),event,...fields});
  const socketId=socket=>{
    if(!socket)return null;
    if(!sockets.has(socket)){
      const id=++nextSocket;sockets.set(socket,id);
      socket.once('close',hadError=>emit('socket_closed',{socket:id,hadError}));
    }
    return sockets.get(socket);
  };
  dc.channel('undici:request:create').subscribe(({request})=>{
    if(request?.path!=='/v1/models'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(request.origin)))return;
    const origin=String(request.origin),key={request:++nextRequest,origin};
    origins.add(origin);requests.set(request,key);emit('created',key);
  });
  dc.channel('undici:client:sendHeaders').subscribe(({request,socket})=>{
    const key=requests.get(request);if(key)emit('sending_headers',{...key,socket:socketId(socket),localPort:socket.localPort,remotePort:socket.remotePort});
  });
  for(const [topic,name] of [['request:bodySent','body_sent'],['request:headers','response_headers'],['request:error','error']]){
    dc.channel('undici:'+topic).subscribe(({request,response,error})=>{
      const key=requests.get(request);
      if(key)emit(name,{...key,status:response?.statusCode,error:error?.code??error?.name});
    });
  }
  for(const [topic,name] of [['client:beforeConnect','connecting'],['client:connected','connected'],['client:connectError','connect_error']]){
    dc.channel('undici:'+topic).subscribe(({connectParams,socket,error})=>{
      const origin='http://'+connectParams?.hostname+':'+connectParams?.port;
      if(origins.has(origin))emit(name,{origin,socket:socketId(socket),error:error?.code??error?.name});
    });
  }
  process.once('exit',()=>fs.writeFileSync(process.env.STAGE17_WIRE_PATH,JSON.stringify(rows)+'\n',{flag:'wx'}));
}
