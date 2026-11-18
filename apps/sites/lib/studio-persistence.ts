export type SaveStatus={phase:'idle'|'pending'|'saving'|'saved'|'error';revision:number;savedRevision:number;error?:string;conflict?:boolean};
/** One writer at a time; pending edits coalesce to the latest complete snapshot. */
export class AutosaveQueue<T> {
 private pending?:{revision:number;value:T};
 private inFlight?:Promise<void>;
 private timer?:ReturnType<typeof setTimeout>;
 private revision=0;
 private savedRevision=0;
 private closed=false;
 private conflict?:Error;
 constructor(private write:(value:T)=>Promise<void>,private onStatus:(state:SaveStatus)=>void,private delay=500){}
 private emit(phase:SaveStatus['phase'],error?:unknown){if(!this.closed)this.onStatus({phase,revision:this.revision,savedRevision:this.savedRevision,...(error?{error:error instanceof Error?error.message:String(error),conflict:error instanceof Error&&error.name==='WorkspaceConflictError'}:{})});}
 schedule(value:T){
  if(this.closed)return;
  this.pending={revision:++this.revision,value};clearTimeout(this.timer);
  // This writer's storage revision cannot recover from another tab's commit.
  // Keep accepting in-memory edits, but never hide the conflict or retry writes.
  if(this.conflict){this.emit('error',this.conflict);return;}
  this.emit(this.inFlight?'saving':'pending');
  this.timer=setTimeout(()=>{void this.flush().catch(()=>{});},this.delay);
 }
 flush():Promise<void>{
  clearTimeout(this.timer);
  if(this.conflict)return Promise.reject(this.conflict);
  if(this.inFlight)return this.inFlight;
  this.inFlight=this.drain().finally(()=>{this.inFlight=undefined;});return this.inFlight;
 }
 private async drain(){
  while(this.pending){
   const snapshot=this.pending;this.pending=undefined;this.emit('saving');
   try{await this.write(snapshot.value);this.savedRevision=snapshot.revision;}
   catch(error){if(error instanceof Error&&error.name==='WorkspaceConflictError')this.conflict=error;this.pending=this.pending||snapshot;this.emit('error',error);throw error;}
  }
  if(this.savedRevision===this.revision&&this.revision>0)this.emit('saved');
 }
 close(){clearTimeout(this.timer);void this.flush().catch(()=>{});this.closed=true;}
}
