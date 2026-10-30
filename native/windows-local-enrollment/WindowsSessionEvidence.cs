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
    internal static SessionEvidence CaptureImpersonated(string ownerSid)
    {
        using var identity=WindowsIdentity.GetCurrent(true);
        Protocol.Require(identity is not null && identity.User?.Value==ownerSid);
        var stats=new byte[56];var session=new byte[4];
        Protocol.Require(GetTokenInformation(identity!.AccessToken,10,stats,(uint)stats.Length,out var count)&&count<=stats.Length);
        Protocol.Require(GetTokenInformation(identity.AccessToken,12,session,4,out count)&&count==4);
        var sessionId=System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(session);
        Protocol.Require(sessionId>0 && sessionId==WTSGetActiveConsoleSessionId());
        Protocol.Require(WTSQuerySessionInformationW(IntPtr.Zero,sessionId,16,out var raw,out var bytes));
        try {Protocol.Require(bytes>=2 && Marshal.ReadInt16(raw)==0);}finally{WTSFreeMemory(raw);}
        Protocol.Require(WTSQuerySessionInformationW(IntPtr.Zero,sessionId,8,out raw,out bytes));
        try {Protocol.Require(bytes>=4 && Marshal.ReadInt32(raw)==0);}finally{WTSFreeMemory(raw);}
        var luid=System.Buffers.Binary.BinaryPrimitives.ReadUInt64LittleEndian(stats.AsSpan(8,8));
        Protocol.Require(luid!=0);
        return new SessionEvidence(Incarnation,checked((int)sessionId),ownerSid,luid.ToString("x16"));
    }
}
