using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Nexowire.LocalEnrollment;

internal static class EnrollmentPipe
{
    private sealed record Request(int Version,string Operation);
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
                string? sid=null;
                pipe.RunAsClient(()=> {using var identity=WindowsIdentity.GetCurrent(true);
                    sid=identity?.User?.Value;});
                Protocol.Require(sid==config.OwnerSid);
                var r=Protocol.Read<Request>(bytes);
                // No unauthenticated signing, enrollment or dispatch opcode.
                // A separately provisioned independent challenge verifier must
                // be integrated before any witness-signing operation is added.
                Protocol.Require(r.Version==2 && r.Operation=="status");
                var (fresh,g)=ProtectedStore.Load();
                Protocol.Require(fresh==config);
                using var key=ProtectedStore.OpenKey(config);using var signer=new ECDsaCng(key);
                var response=JsonSerializer.SerializeToUtf8Bytes(new {version=2,verified=true,
                    grant=g,spkiBase64=Convert.ToBase64String(signer.ExportSubjectPublicKeyInfo()),
                    keyProvider=config.KeyProvider,mayDispatch=false},Protocol.Json);
                System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(lengthBytes,response.Length);
                await pipe.WriteAsync(lengthBytes,deadline.Token);await pipe.WriteAsync(response,deadline.Token);
                await pipe.FlushAsync(deadline.Token);
            }
            catch(Exception e) when(e is IOException or InvalidDataException or JsonException or
                CryptographicException or UnauthorizedAccessException or OperationCanceledException)
            { if(stop.IsCancellationRequested)break; }
            finally{if(pipe.IsConnected)pipe.Disconnect();}
        }
    }
}
