using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Nexowire.LocalEnrollment;

internal static class EnrollmentClient
{
    // Framing/denial validation is not authorization. A separate Agent verifier
    // must pin the installed device key and verify signed grant/witness scope.
    internal static void RequireAcceptedFrame(JsonElement root,string operation)
    {
        Protocol.Require(operation is "status" or "attest" &&
            root.ValueKind==JsonValueKind.Object);
        // A diagnostic pipe response is untrusted. Deny duplicate fields at
        // every depth and any unknown/missing top-level v2 fields.
        Protocol.RejectDuplicates(root);
        var fields=new HashSet<string>(StringComparer.Ordinal);
        foreach(var property in root.EnumerateObject())
        {
            Protocol.Require(property.Name is "version" or "verified" or
                "mayDispatch" or "grant" or "spkiBase64" or "keyProvider" or
                "evidence" or "witness");
            fields.Add(property.Name);
        }
        // Capture the out variable outside short-circuit evaluation so
        // malformed/missing witness remains a rejection, not a compiler
        // definite-assignment ambiguity.
        var witnessPresent=root.TryGetProperty("witness",out var witness);
        Protocol.Require(fields.Count==8 && witnessPresent &&
            root.TryGetProperty("version",out var version) &&
            version.ValueKind==JsonValueKind.Number && version.TryGetInt32(out var v) && v==2 &&
            root.TryGetProperty("verified",out var verified) && verified.ValueKind==JsonValueKind.True &&
            root.TryGetProperty("mayDispatch",out var dispatch) && dispatch.ValueKind==JsonValueKind.False &&
            root.TryGetProperty("grant",out var grant) && grant.ValueKind==JsonValueKind.Object &&
            root.TryGetProperty("evidence",out var evidence) && evidence.ValueKind==JsonValueKind.Object &&
            root.TryGetProperty("spkiBase64",out var key) && key.ValueKind==JsonValueKind.String &&
            key.GetString() is {Length:>0 and <=1024} &&
            root.TryGetProperty("keyProvider",out var provider) && provider.ValueKind==JsonValueKind.String &&
            provider.GetString() is "Microsoft Platform Crypto Provider" or "Microsoft Software Key Storage Provider");
        Protocol.Require(operation=="attest"
            ? witness.ValueKind==JsonValueKind.Object
            : witness.ValueKind==JsonValueKind.Null);
    }
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
        RequireAcceptedFrame(doc.RootElement,operation);
        Console.WriteLine(doc.RootElement.GetRawText());
    }
}
