using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Nexowire.LocalEnrollment;

internal sealed record SessionEvidence(string BootId,int WindowsSessionId,string OwnerSid,string LogonLuid);
internal static class WindowsSessionEvidence
{
    // A fresh protected authority incarnation: every service restart (therefore
    // every OS boot) invalidates all old witnesses. Not an OS boot identifier.
    internal static readonly string Incarnation=Guid.NewGuid().ToString("D");
    [DllImport("advapi32.dll",SetLastError=true)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle token,int informationClass,
        byte[] information,uint length,out uint required);
    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern bool WTSQuerySessionInformationW(IntPtr server,uint session,int informationClass,
        out IntPtr buffer,out uint bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr buffer);
    // Pure policy used by diagnostics. This is not OS evidence until all four
    // facts are obtained from Windows for the same active console session.
    internal static bool ActiveLocalConsoleFacts(int sessionId,uint consoleId,short protocolType,int state) =>
        sessionId>0 && consoleId!=uint.MaxValue && (uint)sessionId==consoleId &&
        protocolType==0 && state==0;

    internal static void RequireActiveLocalConsole(int sessionId)
    {
        var consoleId=WTSGetActiveConsoleSessionId();
        Protocol.Require(sessionId>0 && consoleId!=uint.MaxValue && (uint)sessionId==consoleId);
        Protocol.Require(WTSQuerySessionInformationW(IntPtr.Zero,consoleId,16,out var protocolBuffer,out var protocolBytes));
        short protocolType;
        try {Protocol.Require(protocolBuffer!=IntPtr.Zero && protocolBytes>=2);
            protocolType=Marshal.ReadInt16(protocolBuffer);}
        finally {if(protocolBuffer!=IntPtr.Zero)WTSFreeMemory(protocolBuffer);}
        Protocol.Require(WTSQuerySessionInformationW(IntPtr.Zero,consoleId,8,out var stateBuffer,out var stateBytes));
        int state;
        try {Protocol.Require(stateBuffer!=IntPtr.Zero && stateBytes>=4);
            state=Marshal.ReadInt32(stateBuffer);}
        finally {if(stateBuffer!=IntPtr.Zero)WTSFreeMemory(stateBuffer);}
        // Recheck the active console at the end: session switching midway
        // through native WTS queries must fail closed.
        Protocol.Require(ActiveLocalConsoleFacts(sessionId,consoleId,protocolType,state) &&
            WTSGetActiveConsoleSessionId()==consoleId);
    }
    internal static SessionEvidence CaptureImpersonated(string ownerSid)
    {
        using var identity=WindowsIdentity.GetCurrent(true);
        Protocol.Require(identity is not null && identity.User?.Value==ownerSid);
        var stats=new byte[56];var session=new byte[4];
        Protocol.Require(GetTokenInformation(identity!.AccessToken,10,stats,(uint)stats.Length,out var count)&&count<=stats.Length);
        Protocol.Require(GetTokenInformation(identity.AccessToken,12,session,4,out count)&&count==4);
        var sessionId=System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(session);
        Protocol.Require(sessionId<=int.MaxValue);
        RequireActiveLocalConsole((int)sessionId);
        var luid=System.Buffers.Binary.BinaryPrimitives.ReadUInt64LittleEndian(stats.AsSpan(8,8));
        Protocol.Require(luid!=0);
        return new SessionEvidence(Incarnation,checked((int)sessionId),ownerSid,luid.ToString("x16"));
    }
}
