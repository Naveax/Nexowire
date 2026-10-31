using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Nexowire.LocalEnrollment;

internal static class EnrollmentPipe
{
    private sealed record Request(int Version,string Operation,SignedSession? Challenge=null);
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes
    { public int Length;public IntPtr Descriptor;[MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl,uint revision,out IntPtr sd,out uint size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafePipeHandle CreateNamedPipeW(string name,uint openMode,uint pipeMode,uint instances,
        uint outSize,uint inSize,uint timeout,ref SecurityAttributes sa);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    private static NamedPipeServerStream Create(string ownerSid)
    {
        Protocol.Require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
            "O:SYG:SYD:P(A;;GA;;;SY)(A;;0x12019b;;;"+ownerSid+")",1,out var sd,out _));
        try
        {
            var sa=new SecurityAttributes{Length=Marshal.SizeOf<SecurityAttributes>(),Descriptor=sd,Inherit=false};
            // Duplex | OVERLAPPED | FIRST_PIPE_INSTANCE; byte mode, blocking
            // wait semantics, REJECT_REMOTE_CLIENTS. One instance/request.
            var pipe=CreateNamedPipeW(@"\\.\pipe\Nexowire.LocalEnrollment.v2",3|0x40000000|0x00080000,8,1,16384,16384,0,ref sa);
            if(pipe.IsInvalid){pipe.Dispose();throw new IOException("LOCAL_ENROLLMENT_PIPE_UNAVAILABLE");}
            try{return new NamedPipeServerStream(PipeDirection.InOut,true,false,pipe);}
            catch{pipe.Dispose();throw;}
        }
        finally{LocalFree(sd);}
    }
    internal static async Task Serve(CancellationToken stop)
    {
        var (config,_)=ProtectedStore.Load();
        // Keep the same server instance for its whole lifetime; dropping the
        // final instance between requests would allow pipe-name squatting.
        using var pipe=Create(config.OwnerSid);
        while(!stop.IsCancellationRequested)
        {
            await pipe.WaitForConnectionAsync(stop);
            try
            {
                using var deadline=CancellationTokenSource.CreateLinkedTokenSource(stop);
                deadline.CancelAfter(TimeSpan.FromSeconds(5));
                var lengthBytes=new byte[4];await pipe.ReadExactlyAsync(lengthBytes,deadline.Token);
                var length=System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
                Protocol.Require(length is >0 and <=16384);
                var bytes=new byte[length];await pipe.ReadExactlyAsync(bytes,deadline.Token);
                string? sid=null;SessionEvidence? evidence=null;
                pipe.RunAsClient(()=> {using var identity=WindowsIdentity.GetCurrent(true);
                    sid=identity?.User?.Value;
                    if(sid==config.OwnerSid)evidence=WindowsSessionEvidence.CaptureImpersonated(config.OwnerSid);});
                Protocol.Require(sid==config.OwnerSid && evidence is not null);
                var r=Protocol.Read<Request>(bytes);
                Protocol.Require(r.Version==2 && r.Operation is "status" or "attest");
                // Serialize both signed attestation and read-only status
                // against visible local revocation. Neither may report a
                // verified stale grant after a completed local revoke.
                using var fence=ProtectedStore.AcquireRevocationFence(deadline.Token);
                var (fresh,g)=ProtectedStore.Load();
                Protocol.Require(fresh==config);
                using var key=ProtectedStore.OpenKey(config);using var signer=new ECDsaCng(key);
                SignedSession? witness=null;
                Session? attestedChallenge=null;
                if(r.Operation=="attest")
                {
                    Protocol.Require(r.Challenge is not null);
                    var challenge=r.Challenge!;var p=challenge.Payload;
                    using var authority=ECDsa.Create();
                    var der=Convert.FromBase64String(config.AuthoritySpkiBase64);
                    authority.ImportSubjectPublicKeyInfo(der,out var used);
                    var now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    Protocol.Require(used==der.Length && Protocol.Verify(authority,Protocol.ChallengeBytes(p),challenge.SignatureBase64));
                    Protocol.Require(p.EnrollmentSha256==Protocol.Hash(Protocol.GrantBytes(g.Payload)) &&
                        p.BootId==evidence!.BootId && p.OwnerSid==evidence.OwnerSid &&
                        p.WindowsSessionId==evidence.WindowsSessionId && p.LogonLuid==evidence.LogonLuid &&
                        p.ObservedAtMs<=now && p.ValidUntilMs>now && p.ObservedAtMs>=g.Payload.ConsentedAtMs);
                    ProtectedStore.ConsumeNonce(p.Nonce);
                    // Recheck both protected enrollment/revocation and live
                    // kernel token/session immediately before producing proof.
                    Protocol.Require(ProtectedStore.Load()==(config,g));
                    SessionEvidence? latest=null;
                    pipe.RunAsClient(()=>latest=WindowsSessionEvidence.CaptureImpersonated(config.OwnerSid));
                    Protocol.Require(latest==evidence && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()<p.ValidUntilMs);
                    witness=new SignedSession(p,Convert.ToBase64String(signer.SignData(Protocol.SessionBytes(p),
                        HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation)));
                    attestedChallenge=p;
                }
                else Protocol.Require(r.Challenge is null);
                // Closing the signer/reply TOCTOU window is best effort:
                // the independently operated verifier still needs a final
                // current-session / revocation / one-use authority check.
                SessionEvidence? beforeReply=null;
                pipe.RunAsClient(()=>beforeReply=WindowsSessionEvidence.CaptureImpersonated(config.OwnerSid));
                Protocol.Require(beforeReply==evidence && ProtectedStore.Load()==(config,g));
                if(attestedChallenge is not null)
                    Protocol.RequireFreshSession(attestedChallenge,evidence!,beforeReply,
                        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                deadline.Token.ThrowIfCancellationRequested();
                var response=JsonSerializer.SerializeToUtf8Bytes(new {version=2,verified=true,
                    grant=g,spkiBase64=Convert.ToBase64String(signer.ExportSubjectPublicKeyInfo()),
                    keyProvider=config.KeyProvider,evidence,witness,mayDispatch=false},Protocol.Json);
                Protocol.Require(response.Length is >0 and <=16384);
                System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(lengthBytes,response.Length);
                await pipe.WriteAsync(lengthBytes,deadline.Token);await pipe.WriteAsync(response,deadline.Token);
                await pipe.FlushAsync(deadline.Token);
            }
            catch(Exception e) when(e is not OutOfMemoryException and not StackOverflowException)
            {
                if(stop.IsCancellationRequested)break;
                // A rejected operation must not look like a successful empty
                // response. Send only a bounded, non-sensitive denial; nonce
                // claims made before a lost ACK remain consumed.
                try
                {
                    if(pipe.IsConnected)
                    {
                        using var rejectDeadline=CancellationTokenSource.CreateLinkedTokenSource(stop);
                        rejectDeadline.CancelAfter(TimeSpan.FromMilliseconds(500));
                        var denied=JsonSerializer.SerializeToUtf8Bytes(new {
                            version=2,verified=false,error="LOCAL_ENROLLMENT_REJECTED",mayDispatch=false
                        },Protocol.Json);
                        var prefix=new byte[4];
                        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(prefix,denied.Length);
                        await pipe.WriteAsync(prefix,rejectDeadline.Token);
                        await pipe.WriteAsync(denied,rejectDeadline.Token);
                        await pipe.FlushAsync(rejectDeadline.Token);
                    }
                }
                catch(Exception writeError) when(writeError is not OutOfMemoryException and not StackOverflowException)
                {
                    // Peer disconnect/timeout is still denial; no retry of an
                    // already claimed one-use challenge is performed here.
                }
            }
            finally{if(pipe.IsConnected)pipe.Disconnect();}
        }
    }
}
