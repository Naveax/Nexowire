using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Nexowire.LocalEnrollment;

internal static class WindowsService
{
    internal const string Name="NexowireLocalEnrollment";
    private static readonly CancellationTokenSource Stop=new();
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void ServiceMain(uint argc,IntPtr argv);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate uint Handler(uint control,uint eventType,IntPtr data,IntPtr context);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct Entry
    { [MarshalAs(UnmanagedType.LPWStr)] public string? Name;public IntPtr Main; }
    [StructLayout(LayoutKind.Sequential)] private struct Status
    { public uint Type,State,Accepted,Win32Exit,SpecificExit,Checkpoint,WaitHint; }
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern bool StartServiceCtrlDispatcherW([In] Entry[] entries);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern IntPtr RegisterServiceCtrlHandlerExW(string name,Handler handler,IntPtr context);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool SetServiceStatus(IntPtr handle,ref Status status);
    private static IntPtr handle;
    private static readonly ServiceMain MainCallback=Main;
    private static readonly Handler HandlerCallback=Control;
    internal static void Run()
    {
        using var identity=WindowsIdentity.GetCurrent();Protocol.Require(identity.User?.Value=="S-1-5-18");
        Protocol.Require(StartServiceCtrlDispatcherW(new[]{new Entry{Name=Name,
            Main=Marshal.GetFunctionPointerForDelegate(MainCallback)},new Entry()}));
    }
    private static void Set(uint state,uint accepted=0,uint exit=0)
    {
        var s=new Status{Type=0x10,State=state,Accepted=accepted,Win32Exit=exit,
            WaitHint=state is 2 or 3?15000u:0u};
        if(handle!=IntPtr.Zero)SetServiceStatus(handle,ref s);
    }
    private static uint Control(uint control,uint eventType,IntPtr data,IntPtr context)
    {
        if(control is 1 or 5){Set(3);Stop.Cancel();}return 0;
    }
    private static void Main(uint argc,IntPtr argv)
    {
        handle=RegisterServiceCtrlHandlerExW(Name,HandlerCallback,IntPtr.Zero);
        if(handle==IntPtr.Zero)return;
        try
        {
            Set(2);ProtectedStore.Load();
            // Never load executable/configuration material from Agent-writable
            // directories. The local installer must apply this exact ACL.
            ProtectedStore.AssertPath(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
            Set(4,1|4);EnrollmentPipe.Serve(Stop.Token).GetAwaiter().GetResult();Set(1);
        }
        catch(OperationCanceledException) when(Stop.IsCancellationRequested){Set(1);}
        catch {Set(1,0,13);}
    }
}
