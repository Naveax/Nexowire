using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Nexowire.LocalEnrollment;

internal static class EnrollmentClient
{
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafePipeHandle CreateFileW(string name,uint access,uint share,IntPtr sa,
        uint disposition,uint flags,IntPtr template);
    internal static async Task Run(string operation)
    {
        using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(5));
        byte[] request;
        if(operation=="status")request=JsonSerializer.SerializeToUtf8Bytes(new {version=2,operation},Protocol.Json);
        else
        {
            // Bound stdin before allocation; one signed authority challenge only.
            using var stdin=Console.OpenStandardInput();using var buf=new MemoryStream();
            var chunk=new byte[1024];int read;
            while((read=await stdin.ReadAsync(chunk,deadline.Token))>0)
            {Protocol.Require(buf.Length+read<=16384);buf.Write(chunk,0,read);}
            var challenge=Protocol.Read<SignedSession>(buf.ToArray());
            request=JsonSerializer.SerializeToUtf8Bytes(new {version=2,operation,challenge},Protocol.Json);
        }
        Protocol.Require(request.Length<=16384);
        // Explicit minimal pipe rights omit FILE_CREATE_PIPE_INSTANCE. Generic
        // write access also includes that bit and must not be granted to owner.
        var handle=CreateFileW(@"\\.\pipe\Nexowire.LocalEnrollment.v2",0x12019b,0,IntPtr.Zero,3,
            0x40000000|0x00100000|0x00020000,IntPtr.Zero);
        if(handle.IsInvalid){handle.Dispose();throw new IOException("LOCAL_ENROLLMENT_PIPE_UNAVAILABLE");}
        using var pipe=new NamedPipeClientStream(PipeDirection.InOut,true,true,handle);
        var size=new byte[4];System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(size,request.Length);
        await pipe.WriteAsync(size,deadline.Token);await pipe.WriteAsync(request,deadline.Token);
        await pipe.FlushAsync(deadline.Token);
        await pipe.ReadExactlyAsync(size,deadline.Token);
        var length=System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(size);
        Protocol.Require(length is >0 and <=16384);
        var response=new byte[length];await pipe.ReadExactlyAsync(response,deadline.Token);
        // Wire bytes alone are UNTRUSTED. The Agent/independent verifier must
        // validate the provisioned issuer pin and signed scope before use.
        using var doc=JsonDocument.Parse(response);
        Console.WriteLine(doc.RootElement.GetRawText());
    }
}
