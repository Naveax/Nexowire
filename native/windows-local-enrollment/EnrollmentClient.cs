using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Nexowire.LocalEnrollment;

internal static class EnrollmentClient
{
    // Framing/denial validation is not authorization. A separate Agent verifier
    // must pin the installed device key and verify signed grant/witness scope.
    internal static void RequireAcceptedFrame(JsonElement root,string operation,
        SignedSession? submittedChallenge=null)
    {
        Protocol.Require(operation is "status" or "attest" &&
            root.ValueKind==JsonValueKind.Object &&
            (operation=="attest" ? submittedChallenge?.Payload is not null :
                submittedChallenge is null));
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
        var grantPresent=root.TryGetProperty("grant",out var grant);
        var evidencePresent=root.TryGetProperty("evidence",out var evidence);
        var keyPresent=root.TryGetProperty("spkiBase64",out var key);
        Protocol.Require(fields.Count==8 && witnessPresent && grantPresent &&
            evidencePresent && keyPresent &&
            root.TryGetProperty("version",out var version) &&
            version.ValueKind==JsonValueKind.Number && version.TryGetInt32(out var v) && v==2 &&
            root.TryGetProperty("verified",out var verified) && verified.ValueKind==JsonValueKind.True &&
            root.TryGetProperty("mayDispatch",out var dispatch) && dispatch.ValueKind==JsonValueKind.False &&
            grant.ValueKind==JsonValueKind.Object &&
            evidence.ValueKind==JsonValueKind.Object &&
            key.ValueKind==JsonValueKind.String &&
            key.GetString() is {Length:>0 and <=1024} &&
            root.TryGetProperty("keyProvider",out var provider) && provider.ValueKind==JsonValueKind.String &&
            provider.GetString() is "Microsoft Platform Crypto Provider" or "Microsoft Software Key Storage Provider");
        Protocol.Require(operation=="attest"
            ? witness.ValueKind==JsonValueKind.Object
            : witness.ValueKind==JsonValueKind.Null);

        // Self-consistent cryptography is a necessary, never sufficient,
        // condition before emitting a "verified:true" IPC frame to stdout.
        // The independent Agent verifier MUST still pin the installed device
        // identity, issuer, grant generation and current revocation/CAS.
        try
        {
            var encoded=key.GetString() ?? throw new InvalidDataException("LOCAL_ENROLLMENT_REJECTED");
            var issuerHash=Program.RequireCanonicalAuthoritySpki(encoded);
            var signed=Protocol.Read<SignedGrant>(Encoding.UTF8.GetBytes(grant.GetRawText()));
            var payload=signed.Payload ?? throw new InvalidDataException("LOCAL_ENROLLMENT_REJECTED");
            Protocol.Require(payload.IssuerSpkiSha256==issuerHash);
            var grantBytes=Protocol.GrantBytes(payload);
            using var signer=ECDsa.Create();
            var der=Convert.FromBase64String(encoded);
            signer.ImportSubjectPublicKeyInfo(der,out var consumed);
            Protocol.Require(consumed==der.Length &&
                Protocol.Verify(signer,grantBytes,signed.SignatureBase64));

            var snapshot=Protocol.Read<SessionEvidence>(Encoding.UTF8.GetBytes(evidence.GetRawText()));
            Protocol.Require(Protocol.Uuid(snapshot.BootId) &&
                snapshot.WindowsSessionId>0 && snapshot.OwnerSid==payload.OwnerSid &&
                snapshot.LogonLuid is {Length:16} &&
                Regex.IsMatch(snapshot.LogonLuid,"^[a-f0-9]{16}\\z") &&
                snapshot.LogonLuid!="0000000000000000");

            if(operation=="attest")
            {
                var signedWitness=Protocol.Read<SignedSession>(
                    Encoding.UTF8.GetBytes(witness.GetRawText()));
                var w=signedWitness.Payload ??
                    throw new InvalidDataException("LOCAL_ENROLLMENT_REJECTED");
                // Bind this reply to the exact request we just sent. A valid
                // signed witness from an earlier or parallel challenge cannot
                // satisfy another nonce, boot/session or owner scope.
                Protocol.Require(w==submittedChallenge!.Payload &&
                    w.EnrollmentSha256==Protocol.Hash(grantBytes) &&
                    w.OwnerSid==snapshot.OwnerSid && w.BootId==snapshot.BootId &&
                    w.WindowsSessionId==snapshot.WindowsSessionId &&
                    w.LogonLuid==snapshot.LogonLuid &&
                    w.ObservedAtMs>=payload.ConsentedAtMs &&
                    Protocol.Verify(signer,Protocol.SessionBytes(w),
                        signedWitness.SignatureBase64));
            }
        }
        catch(Exception e) when(e is JsonException or CryptographicException or FormatException
            or ArgumentException or NotSupportedException)
        { throw new InvalidDataException("LOCAL_ENROLLMENT_REJECTED"); }
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafePipeHandle CreateFileW(string name,uint access,uint share,IntPtr sa,
        uint disposition,uint flags,IntPtr template);
    internal static async Task Run(string operation)
    {
        using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(5));
        byte[] request;
        SignedSession? submittedChallenge=null;
        if(operation=="status")request=JsonSerializer.SerializeToUtf8Bytes(new {version=2,operation},Protocol.Json);
        else
        {
            // Bound stdin before allocation; one signed authority challenge only.
            using var stdin=Console.OpenStandardInput();using var buf=new MemoryStream();
            var chunk=new byte[1024];int read;
            while((read=await stdin.ReadAsync(chunk,deadline.Token))>0)
            {Protocol.Require(buf.Length+read<=16384);buf.Write(chunk,0,read);}
            var challenge=Protocol.Read<SignedSession>(buf.ToArray());
            submittedChallenge=challenge;
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
        RequireAcceptedFrame(doc.RootElement,operation,submittedChallenge);
        // Even a locally valid signature cannot excuse an expired attestation
        // after transport or scheduling delays. The external verifier must
        // perform its own current-session and revoke readback too.
        if(operation=="attest")
        {
            var w=doc.RootElement.GetProperty("witness").GetProperty("payload");
            Protocol.Require(w.GetProperty("observedAtMs").GetInt64()<=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() &&
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()<w.GetProperty("validUntilMs").GetInt64());
        }
        Console.WriteLine(doc.RootElement.GetRawText());
    }
}
