param([Parameter(Mandatory=$true)][string]$ControlRoot)
$ErrorActionPreference = 'Stop'
# Harness-only Win32 supervisor. Compilation/temp/output stay under the caller's E run.
# No product process owner, global PID scan, taskkill, shell command, or named Job is used.
if (-not [IO.Path]::IsPathRooted($ControlRoot) -or $ControlRoot -notmatch '^E:[\\/]') { exit 81 }
$env:TEMP = $ControlRoot
$env:TMP = $ControlRoot
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
$definition = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public static class MangohanaWarmJob {
  const uint CREATE_SUSPENDED=0x00000004, CREATE_NO_WINDOW=0x08000000;
  const uint EXTENDED_STARTUPINFO_PRESENT=0x00080000, CREATE_UNICODE_ENVIRONMENT=0x00000400;
  const uint STARTF_USESTDHANDLES=0x00000100, KILL_ON_JOB_CLOSE=0x00002000;
  const uint DUPLICATE_SAME_ACCESS=2, WAIT_OBJECT_0=0, WAIT_TIMEOUT=258;
  const uint QUERY_AND_SYNCHRONIZE=0x00101000;
  const int STD_OUTPUT_HANDLE=-11, STD_ERROR_HANDLE=-12;
  static readonly IntPtr INVALID_HANDLE_VALUE=new IntPtr(-1);
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public int cb; public IntPtr lpReserved,lpDesktop,lpTitle;
    public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
    public ushort wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass,SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
  sealed class Member { public uint Pid; public IntPtr Handle; public long Created; }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT value,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr value,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true,EntryPoint="QueryInformationJobObject")] static extern bool QueryAccounting(IntPtr job,int info,out ACCOUNTING value,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inJob);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref UIntPtr bytes);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr bytes,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static Exception Error(string code) { return new InvalidOperationException(code+":"+Marshal.GetLastWin32Error()); }
  static void Check(bool value,string code) { if(!value) throw Error(code); }
  static Dictionary<string,object> Row(params object[] pairs) { var row=new Dictionary<string,object>(); for(int i=0;i<pairs.Length;i+=2)row[(string)pairs[i]]=pairs[i+1];return row; }
  static void Emit(Dictionary<string,object> value) { Console.Out.WriteLine("MANGOHANA_WARM_JOB_V1 "+Json.Serialize(value));Console.Out.Flush(); }
  static long Creation(IntPtr process,uint pid) { long created,exit,kernel,user;Check(GetProcessId(process)==pid,"JOB_HANDLE_PID_IDENTITY");Check(GetProcessTimes(process,out created,out exit,out kernel,out user),"JOB_CREATION_IDENTITY");return created; }
  static IntPtr DuplicateStandard(int which) { IntPtr original=GetStdHandle(which),duplicate;if(original==IntPtr.Zero||original==INVALID_HANDLE_VALUE)throw Error("JOB_OUTPUT_HANDLE_REQUIRED");Check(DuplicateHandle(GetCurrentProcess(),original,GetCurrentProcess(),out duplicate,0,true,DUPLICATE_SAME_ACCESS),"JOB_OUTPUT_DUPLICATE");return duplicate; }
  // Microsoft C runtime quoting: backslashes before quotes and closing quote are doubled.
  static string Quote(string value) { if(value==null||value.IndexOf('\0')>=0)throw new InvalidOperationException("JOB_ARGUMENT_INVALID");var text=new StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){text.Append('\\',slashes*2+1);text.Append(c);}else{text.Append('\\',slashes);text.Append(c);}slashes=0;}text.Append('\\',slashes*2);text.Append('"');return text.ToString(); }
  static IntPtr EnvironmentBlock() {
    var allowed=new HashSet<string>(new string[]{"SystemRoot","WINDIR","PATH","PATHEXT","ComSpec","PROCESSOR_ARCHITECTURE","NUMBER_OF_PROCESSORS","TEMP","TMP","LOCALAPPDATA","TRIO_DISABLE_AUTO_UPDATE","HF_HUB_OFFLINE","TRANSFORMERS_OFFLINE","ProgramW6432","ProgramFiles","ProgramData","ALLUSERSPROFILE"},StringComparer.OrdinalIgnoreCase);
    var entries=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);foreach(DictionaryEntry entry in Environment.GetEnvironmentVariables()){string key=(string)entry.Key;if(allowed.Contains(key))entries[key]=(string)entry.Value;}
    var block=new StringBuilder();foreach(var entry in entries)block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');block.Append('\0');return Marshal.StringToHGlobalUni(block.ToString());
  }
  static uint Active(IntPtr job) { ACCOUNTING value;Check(QueryAccounting(job,1,out value,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero),"JOB_ACCOUNTING_FAILED");return value.ActiveProcesses; }
  static void Observe(IntPtr job,Dictionary<string,Member> members,IntPtr root,uint rootPid,long rootCreated) {
    IntPtr buffer=Marshal.AllocHGlobal(8+4096*IntPtr.Size);try {
      Check(QueryInformationJobObject(job,3,buffer,(uint)(8+4096*IntPtr.Size),IntPtr.Zero),"JOB_MEMBER_QUERY_FAILED");int count=Marshal.ReadInt32(buffer,4);if(count<0||count>4096)throw new InvalidOperationException("JOB_MEMBER_LIMIT");
      for(int index=0;index<count;index++){
        uint pid=unchecked((uint)Marshal.ReadIntPtr(buffer,8+index*IntPtr.Size).ToInt64());if(pid==rootPid)continue;
        IntPtr handle=OpenProcess(QUERY_AND_SYNCHRONIZE,false,pid);if(handle==IntPtr.Zero)continue;
        bool keep=false;try{bool member;Check(IsProcessInJob(handle,job,out member),"JOB_MEMBER_IDENTITY_QUERY");if(!member)continue;long created=Creation(handle,pid);string key=pid+":"+created;if(members.ContainsKey(key))continue;members[key]=new Member{Pid=pid,Handle=handle,Created=created};keep=true;}finally{if(!keep)CloseHandle(handle);}
      }
    } finally {Marshal.FreeHGlobal(buffer);}
  }
  public static int Run(string runId,string directory,string executable,string[] args,string cwd,int cleanupMs,int maxLifetimeMs,long compileStarted,long compileEnded) {
    IntPtr job=IntPtr.Zero,attributes=IntPtr.Zero,jobValue=IntPtr.Zero,handleValue=IntPtr.Zero,environment=IntPtr.Zero,stdout=IntPtr.Zero,stderr=IntPtr.Zero;PROCESS_INFORMATION process=new PROCESS_INFORMATION();bool attributesInitialized=false,ready=false,resumed=false,identity=false,terminated=false,confirmed=false;string reason="startup_failed",failure=null;long created=0,exitedAt=0;uint rootCode=259,activeAfter=UInt32.MaxValue;var members=new Dictionary<string,Member>();var clock=Stopwatch.StartNew();
    try {
      if(IntPtr.Size!=8||Marshal.SizeOf(typeof(STARTUPINFOEX))!=112||Marshal.SizeOf(typeof(EXTENDED_LIMIT))!=144||Marshal.SizeOf(typeof(ACCOUNTING))!=48)throw new InvalidOperationException("JOB_X64_LAYOUT_REQUIRED");
      job=CreateJobObjectW(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"JOB_CREATE_FAILED");var limit=new EXTENDED_LIMIT();limit.BasicLimitInformation.LimitFlags=KILL_ON_JOB_CLOSE;Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(limit)),"JOB_LIMIT_FAILED");
      UIntPtr bytes=UIntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);if(bytes==UIntPtr.Zero)throw Error("JOB_ATTRIBUTE_SIZE");attributes=Marshal.AllocHGlobal((int)bytes.ToUInt64());Check(InitializeProcThreadAttributeList(attributes,2,0,ref bytes),"JOB_ATTRIBUTE_INIT");attributesInitialized=true;
      jobValue=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobValue,job);Check(UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x0002000D),jobValue,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"JOB_ATOMIC_ASSIGN_UNSUPPORTED");
      stdout=DuplicateStandard(STD_OUTPUT_HANDLE);stderr=DuplicateStandard(STD_ERROR_HANDLE);handleValue=Marshal.AllocHGlobal(IntPtr.Size*2);Marshal.WriteIntPtr(handleValue,0,stdout);Marshal.WriteIntPtr(handleValue,IntPtr.Size,stderr);Check(UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x00020002),handleValue,new UIntPtr((uint)(IntPtr.Size*2)),IntPtr.Zero,IntPtr.Zero),"JOB_HANDLE_ALLOWLIST_FAILED");
      var startup=new STARTUPINFOEX();startup.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=IntPtr.Zero;startup.StartupInfo.hStdOutput=stdout;startup.StartupInfo.hStdError=stderr;startup.lpAttributeList=attributes;
      var command=new StringBuilder(Quote(executable));foreach(string argument in args)command.Append(' ').Append(Quote(argument));if(command.Length>=32767)throw new InvalidOperationException("JOB_COMMAND_TOO_LONG");environment=EnvironmentBlock();
      // Atomic Job-list assignment prevents the create-suspended/assign crash gap.
      Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT,environment,cwd,ref startup,out process),"JOB_ATOMIC_PROCESS_CREATE_FAILED");
      bool assigned;Check(IsProcessInJob(process.hProcess,job,out assigned)&&assigned,"JOB_MEMBERSHIP_REQUIRED");created=Creation(process.hProcess,process.dwProcessId);identity=true;ready=true;
      Emit(Row("phase","ready","runId",runId,"supervisorPid",Process.GetCurrentProcess().Id,"rootPid",process.dwProcessId,"rootCreationTime100ns",created.ToString(),"jobAssigned",true,"launchMechanism","ATOMIC_JOB_LIST_SUSPENDED","inheritedHandles","STDOUT_STDERR_ONLY","pointerBytes",IntPtr.Size));
      Task<string> input=Task.Run(()=>Console.In.ReadLine());long gateDeadline=Math.Min(30000,maxLifetimeMs);
      while(true) {
        Observe(job,members,process.hProcess,process.dwProcessId,created);
        if(WaitForSingleObject(process.hProcess,0)==WAIT_OBJECT_0){reason="root_exit";break;}
        if(clock.ElapsedMilliseconds>maxLifetimeMs){reason="lifetime_timeout";break;}
        if(!resumed&&clock.ElapsedMilliseconds>gateDeadline){reason="resume_timeout";break;}
        if(input.IsCompleted){string line=input.GetAwaiter().GetResult();if(line==null){reason="controller_eof";break;}if(line=="STOP:"+runId){reason="controller_stop";break;}if(line=="RESUME:"+runId&&!resumed){Check(Creation(process.hProcess,process.dwProcessId)==created,"JOB_RESUME_IDENTITY");Check(ResumeThread(process.hThread)==1,"JOB_RESUME_FAILED");CloseHandle(process.hThread);process.hThread=IntPtr.Zero;resumed=true;Emit(Row("phase","resumed","runId",runId,"rootPid",process.dwProcessId));}else{reason="invalid_control";break;}input=Task.Run(()=>Console.In.ReadLine());}
        Thread.Sleep(40);
      }
    } catch(Exception error) { failure=error.Message.StartsWith("JOB_")?error.Message.Split(':')[0]:"JOB_SUPERVISOR_FAILED"; }
    finally {
      var rows=new List<Dictionary<string,object>>();try {
        if(process.hProcess!=IntPtr.Zero) {
          // Retained HANDLE + creation identity, never a newly opened PID kill target.
          identity=identity&&Creation(process.hProcess,process.dwProcessId)==created;
          Observe(job,members,process.hProcess,process.dwProcessId,created);
          if(identity&&Active(job)>0){Check(TerminateJobObject(job,87),"JOB_TERMINATE_FAILED");terminated=true;}
          var cleanup=Stopwatch.StartNew();while(cleanup.ElapsedMilliseconds<cleanupMs){activeAfter=Active(job);bool observedExited=true;foreach(var member in members.Values)observedExited=observedExited&&WaitForSingleObject(member.Handle,0)==WAIT_OBJECT_0;if(activeAfter==0&&WaitForSingleObject(process.hProcess,0)==WAIT_OBJECT_0&&observedExited)break;Thread.Sleep(30);}
          Check(GetExitCodeProcess(process.hProcess,out rootCode),"JOB_EXIT_CODE_FAILED");
          bool allExited=true;foreach(var member in members.Values){bool memberIdentity=Creation(member.Handle,member.Pid)==member.Created;bool exited=WaitForSingleObject(member.Handle,0)==WAIT_OBJECT_0;allExited=allExited&&memberIdentity&&exited;rows.Add(Row("pid",member.Pid,"creationTime100ns",member.Created.ToString(),"identityConfirmed",memberIdentity,"exited",exited));}
          confirmed=identity&&activeAfter==0&&WaitForSingleObject(process.hProcess,0)==WAIT_OBJECT_0&&allExited;
          if(identity&&WaitForSingleObject(process.hProcess,0)==WAIT_OBJECT_0) {
            long sameCreation,exitTime,kernel,user;
            if(GetProcessTimes(process.hProcess,out sameCreation,out exitTime,out kernel,out user)&&sameCreation==created&&exitTime>0)exitedAt=exitTime;
          }
        }
      } catch(Exception error) {failure=failure??(error.Message.StartsWith("JOB_")?error.Message.Split(':')[0]:"JOB_CLEANUP_FAILED");confirmed=false;}
      // Last private handle close also kills descendants if the normal query/terminate path failed.
      if(job!=IntPtr.Zero){if(!CloseHandle(job))confirmed=false;job=IntPtr.Zero;}
      if(process.hThread!=IntPtr.Zero)CloseHandle(process.hThread);if(process.hProcess!=IntPtr.Zero)CloseHandle(process.hProcess);foreach(var member in members.Values)CloseHandle(member.Handle);
      if(stdout!=IntPtr.Zero)CloseHandle(stdout);if(stderr!=IntPtr.Zero)CloseHandle(stderr);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);if(attributesInitialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(jobValue!=IntPtr.Zero)Marshal.FreeHGlobal(jobValue);if(handleValue!=IntPtr.Zero)Marshal.FreeHGlobal(handleValue);
      var receipt=Row("phase","complete","runId",runId,"supervisorPid",Process.GetCurrentProcess().Id,"rootPid",process.dwProcessId,"rootCreationTime100ns",created.ToString(),"rootExitCode",rootCode,"reason",reason,"failure",failure,"ready",ready,"resumed",resumed,"terminationRequested",terminated,"kernelCleanupConfirmed",confirmed,"activeProcessesAfter",activeAfter==UInt32.MaxValue?(object)null:activeAfter,"members",rows,"elapsedMs",clock.ElapsedMilliseconds,"scope","OWNED_KERNEL_JOB_ONLY_NO_AI_CLAIM");
      receipt["rootExitTime100ns"]=exitedAt>0?exitedAt.ToString():null;
      long supervisorCreated,ignoredExit,ignoredKernel,ignoredUser;
      receipt["supervisorCreationTime100ns"]=GetProcessTimes(GetCurrentProcess(),out supervisorCreated,out ignoredExit,out ignoredKernel,out ignoredUser)?supervisorCreated.ToString():null;
      receipt["helperCompileStartTime100ns"]=compileStarted.ToString();
      receipt["helperCompileEndTime100ns"]=compileEnded.ToString();
      try{using(var file=new FileStream(Path.Combine(directory,"job-control-receipt.json"),FileMode.CreateNew,FileAccess.Write,FileShare.Read)){byte[] body=new UTF8Encoding(false).GetBytes(Json.Serialize(receipt));file.Write(body,0,body.Length);file.Flush(true);}}catch{confirmed=false;receipt["kernelCleanupConfirmed"]=false;receipt["failure"]="JOB_RECEIPT_WRITE_FAILED";}
      Emit(receipt);
    }
    return confirmed&&failure==null?0:82;
  }
}
'@
try {
  $compileStarted = [DateTime]::UtcNow.ToFileTimeUtc()
  Add-Type -TypeDefinition $definition -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
  $compileEnded = [DateTime]::UtcNow.ToFileTimeUtc()
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line.Length -gt 65536) { exit 83 }
  $spec = $line | ConvertFrom-Json
  if ($spec.runId -notmatch '^[-A-Za-z0-9._]{1,128}$' -or -not [IO.Path]::IsPathRooted($spec.executable) -or -not [IO.Path]::IsPathRooted($spec.cwd) -or $spec.cleanupMs -lt 100 -or $spec.cleanupMs -gt 60000 -or $spec.maxLifetimeMs -lt 1000 -or $spec.maxLifetimeMs -gt 3600000) { exit 84 }
  $result = [MangohanaWarmJob]::Run([string]$spec.runId,$ControlRoot,[string]$spec.executable,[string[]]$spec.args,[string]$spec.cwd,[int]$spec.cleanupMs,[int]$spec.maxLifetimeMs,$compileStarted,$compileEnded)
  exit $result
} catch {
  # Do not serialize exception details: input/options/environment may contain private data.
  [Console]::Out.WriteLine('MANGOHANA_WARM_JOB_V1 {"phase":"failed","failure":"JOB_HELPER_INITIALIZATION_FAILED","kernelCleanupConfirmed":false}')
  exit 85
}
