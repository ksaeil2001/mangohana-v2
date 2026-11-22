export type StudioShortcut='consume'|'download'|'undo'|'redo'|'close-scope'|'close-drawer'|'cycle-drawer'|'select'|'brush'|'add-text'|'toggle-ocr'|'clear-selection'|'previous-page'|'next-page'|'shortcuts';
type KeyInput={key:string;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean;isComposing?:boolean};
type ShortcutContext={ready:boolean;busy:boolean;hasPage:boolean;modal:boolean;drawer:boolean;scopeMenu:boolean;editable:boolean;browsing?:boolean};

/** Nearest overlay/input owns its keys; only declared workspace chords escape it. */
export function resolveStudioShortcut(event:KeyInput,context:ShortcutContext):StudioShortcut|null {
 if(event.isComposing)return null;
 const key=event.key.toLowerCase(),command=event.ctrlKey||event.metaKey;
 if(command&&!event.altKey&&key==='s')return !context.modal&&!context.browsing&&context.ready&&!context.busy&&context.hasPage?'download':'consume';
 if(context.modal)return null;
 if(event.key==='Escape'&&context.scopeMenu)return 'close-scope';
 if(context.drawer)return event.key==='Escape'?'close-drawer':event.key==='Tab'?'cycle-drawer':null;
 if(context.editable)return null;
 if(context.browsing)return null;
 if(command&&!event.altKey&&key==='z')return context.ready&&!context.busy?(event.shiftKey?'redo':'undo'):'consume';
 if(command||event.altKey||!context.ready)return null;
 switch(key){
  case 'v':return 'select';
  case 'b':return 'brush';
  case 't':return 'add-text';
  case 'o':return 'toggle-ocr';
  case 'escape':return 'clear-selection';
  case 'arrowleft':return 'previous-page';
  case 'arrowright':return 'next-page';
  case '?':return 'shortcuts';
  default:return null;
 }
}
