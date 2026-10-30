using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Nexowire.LocalEnrollment;

internal sealed record Grant(int Version, string Algorithm, string Scope,
    string OwnerAccountId, string OwnerSid, string DeviceId, string InstallationId,
    string EnrollmentId, string MachineBindingSha256, string IssuerSpkiSha256,
    long Generation, long ConsentedAtMs, object? ExpiresAt);
internal sealed record Session(int Version, string EnrollmentSha256, string Nonce,
    string Audience, string BootId, int WindowsSessionId, string OwnerSid,
    string LogonLuid, long ObservedAtMs, long ValidUntilMs);
internal sealed record SignedGrant(Grant Payload, string SignatureBase64);
internal sealed record SignedSession(Session Payload, string SignatureBase64);

internal static partial class Protocol
{
    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        MaxDepth = 8,
        RespectRequiredConstructorParameters = true
    };
    [GeneratedRegex("^[a-f0-9]{64}$")] private static partial Regex Hex();
    [GeneratedRegex("^S-1-[0-9]+(?:-[0-9]+)+$")] private static partial Regex Sid();
    // Restrict deployment account IDs to ASCII, avoiding cross-language JSON
    // escaping differences. This is stricter than the generic TS wire schema.
    [GeneratedRegex("^[A-Za-z0-9._:@-]{8,128}$")] private static partial Regex Account();
    internal static void Require(bool ok)
    { if (!ok) throw new InvalidDataException("LOCAL_ENROLLMENT_REJECTED"); }
    internal static bool Uuid(string? s) => s is not null && Guid.TryParseExact(s,"D",out _);
    internal static void Validate(Grant g)
    {
        Require(g.Version == 2 && g.Algorithm == "ES256-P1363" && g.Scope == "physical-console" &&
            Account().IsMatch(g.OwnerAccountId) && Sid().IsMatch(g.OwnerSid) &&
            Uuid(g.DeviceId) && Uuid(g.InstallationId) && Uuid(g.EnrollmentId) &&
            Hex().IsMatch(g.MachineBindingSha256) && Hex().IsMatch(g.IssuerSpkiSha256) &&
            g.Generation > 0 && g.Generation <= 9007199254740991 &&
            g.ConsentedAtMs > 0 && g.ConsentedAtMs <= 9007199254740991 && g.ExpiresAt is null);
    }
    internal static byte[] GrantBytes(Grant g)
    {
        Validate(g);
        return Encoding.UTF8.GetBytes("nexowire.local.enrollment.v2\0" + JsonSerializer.Serialize(new object?[] {
            g.Version,g.Algorithm,g.Scope,g.OwnerAccountId,g.OwnerSid,g.DeviceId,g.InstallationId,
            g.EnrollmentId,g.MachineBindingSha256,g.IssuerSpkiSha256,g.Generation,g.ConsentedAtMs,null
        },Json));
    }
    internal static byte[] SessionBytes(Session s)
    {
        Require(s.Version == 2 && Hex().IsMatch(s.EnrollmentSha256) && Uuid(s.Nonce) &&
            s.Audience == "nexowire.local-enrollment.session" && Uuid(s.BootId) &&
            s.WindowsSessionId > 0 && Sid().IsMatch(s.OwnerSid) &&
            Regex.IsMatch(s.LogonLuid,"^[a-f0-9]{16}$") && s.LogonLuid != "0000000000000000" &&
            s.ObservedAtMs > 0 && s.ValidUntilMs <= 9007199254740991 &&
            s.ValidUntilMs > s.ObservedAtMs && s.ValidUntilMs - s.ObservedAtMs <= 30000);
        return Encoding.UTF8.GetBytes("nexowire.local.session.v2\0" + JsonSerializer.Serialize(new object[] {
            s.Version,s.EnrollmentSha256,s.Nonce,s.Audience,s.BootId,s.WindowsSessionId,
            s.OwnerSid,s.LogonLuid,s.ObservedAtMs,s.ValidUntilMs
        },Json));
    }
    internal static byte[] ChallengeBytes(Session s) =>
        Encoding.UTF8.GetBytes("nexowire.local.session.challenge.v2\0").Concat(SessionBytes(s)).ToArray();
    internal static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    internal static bool Verify(ECDsa key, byte[] bytes, string signature)
    {
        try
        {
            var sig = Convert.FromBase64String(signature);
            return sig.Length == 64 && Convert.ToBase64String(sig) == signature &&
                key.KeySize == 256 && key.ExportParameters(false).Curve.Oid.Value == "1.2.840.10045.3.1.7" &&
                key.VerifyData(bytes,sig,HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (Exception e) when (e is FormatException or CryptographicException) { return false; }
    }
    internal static T Read<T>(byte[] bytes)
    {
        Require(bytes.Length <= 16384);
        using var doc = JsonDocument.Parse(bytes,new JsonDocumentOptions { MaxDepth = 8 });
        RejectDuplicates(doc.RootElement);
        return JsonSerializer.Deserialize<T>(bytes,Json) ?? throw new InvalidDataException("LOCAL_ENROLLMENT_REJECTED");
    }
    private static void RejectDuplicates(JsonElement e)
    {
        if (e.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach(var p in e.EnumerateObject()) { Require(names.Add(p.Name)); RejectDuplicates(p.Value); }
        }
        else if(e.ValueKind == JsonValueKind.Array) foreach(var v in e.EnumerateArray()) RejectDuplicates(v);
    }
}
