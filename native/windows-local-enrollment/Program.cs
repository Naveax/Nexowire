using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace Nexowire.LocalEnrollment;

internal static class Program
{
    private sealed record EnrollmentRequest(string OwnerAccountId,string OwnerSid,string DeviceId,
        string InstallationId,string AuthoritySpkiBase64);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern int MessageBoxW(IntPtr hwnd,string text,string title,uint flags);
    internal static int Main(string[] args)
    {
        try
        {
            Protocol.Require(OperatingSystem.IsWindows());
            if(args.Length==1 && args[0]=="--self-test") { SelfTest.Run();return 0; }
            if(args.Length==1 && args[0]=="--machine-key-self-test") { SelfTest.MachineKey();return 0; }
            if(args.Length==1 && args[0]=="--service") { WindowsService.Run();return 0; }
            if(args.Length==1 && args[0] is "--status" or "--attest")
            {EnrollmentClient.Run(args[0]=="--status"?"status":"attest").GetAwaiter().GetResult();return 0;}
            if(args.Length==1 && args[0]=="--inspect")
            {
                ProtectedStore.RequireAdministrator();var (_,g)=ProtectedStore.Load();
                Console.WriteLine(JsonSerializer.Serialize(new {verified=true,enrollmentId=g.Payload.EnrollmentId,
                    expiresAt=(object?)null},Protocol.Json));return 0;
            }
            if(args.Length==1 && args[0]=="--revoke")
            {
                ProtectedStore.RequireAdministrator();
                var (c,g)=ProtectedStore.Load();RequireOwner(c.OwnerSid);
                Protocol.Require(Environment.UserInteractive && Process.GetCurrentProcess().SessionId>0);
                Protocol.Require(MessageBoxW(IntPtr.Zero,"Bu bilgisayardaki kalıcı Nexowire kaydı iptal edilsin mi?\n"+
                    "Yeniden etkinleştirme yeni yerel onay gerektirir.","Nexowire — Kaydı iptal et",0x00010000|0x00000100|0x00000004|0x00000030)==6);
                ProtectedStore.WriteNew("revoked.json",new {version=1,enrollmentId=g.Payload.EnrollmentId,
                    generation=g.Payload.Generation,revokedAtMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()});
                return 0;
            }
            if(args.Length==3 && args[0]=="--enroll" && args[2] is "tpm" or "software")
            { Enroll(args[1],args[2]);return 0; }
            Console.Error.WriteLine("LOCAL_ENROLLMENT_INVALID_COMMAND");return 2;
        }
        catch { Console.Error.WriteLine("LOCAL_ENROLLMENT_REJECTED");return 1; }
    }
    private static void RequireOwner(string sid)
    {
        using var current=WindowsIdentity.GetCurrent();
        Protocol.Require(current.User?.Value==sid && current.User?.Value!="S-1-5-18");
    }
    private static void Enroll(string path,string mode)
    {
        ProtectedStore.RequireAdministrator();
        Protocol.Require(Environment.UserInteractive && Process.GetCurrentProcess().SessionId>0);
        var info=new FileInfo(path);Protocol.Require(info.Exists&&info.Length<=16384&&
            (info.Attributes&FileAttributes.ReparsePoint)==0);
        var request=Protocol.Read<EnrollmentRequest>(File.ReadAllBytes(path));RequireOwner(request.OwnerSid);
        var provider=mode=="tpm"?"Microsoft Platform Crypto Provider":"Microsoft Software Key Storage Provider";
        // Independent verifier trust must be explicitly provisioned. Fixture
        // keys are never installed automatically by this executable.
        using var authority=ECDsa.Create();
        var authorityDer=Convert.FromBase64String(request.AuthoritySpkiBase64);
        authority.ImportSubjectPublicKeyInfo(authorityDer,out var consumed);
        Protocol.Require(consumed==authorityDer.Length && authority.KeySize==256 &&
            authority.ExportParameters(false).Curve.Oid.Value=="1.2.840.10045.3.1.7");
        var enrollmentId=Guid.NewGuid().ToString("D");
        var g=new Grant(2,"ES256-P1363","physical-console",request.OwnerAccountId,request.OwnerSid,
            request.DeviceId,request.InstallationId,enrollmentId,ProtectedStore.MachineBinding(),
            new string('0',64),1,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),null);
        Protocol.Validate(g);
        var keyName="Nexowire.LocalEnrollment."+Guid.NewGuid().ToString("D");
        // Deny overwriting/re-enrolling any existing, partial or revoked state.
        if(Directory.Exists(ProtectedStore.Root))
        { ProtectedStore.AssertPath(ProtectedStore.Root);Protocol.Require(!Directory.EnumerateFileSystemEntries(ProtectedStore.Root).Any()); }
        var approved=MessageBoxW(IntPtr.Zero,
            "Bu bilgisayar için süresiz ve iptal edilebilir Nexowire kaydı oluşturulsun mu?\n\n"+
            "Cihaz: "+request.DeviceId+"\nWindows sahibi: "+request.OwnerSid+
            "\nAnahtar: "+(mode=="tpm"?"TPM (dışa aktarılamaz)":"YAZILIM — TPM koruması yok")+
            "\n\nYeniden başlatma veya internet kesintisi yeniden onay gerektirmez.\n"+
            "İptal komutu: Nexowire.LocalEnrollment.exe --revoke\n"+
            "Bu kayıt tek başına uzaktan komut yetkisi veya UAC otomasyonu vermez.",
            "Nexowire — Kalıcı yerel kayıt",0x00010000|0x00000100|0x00000004|0x00000030);
        Protocol.Require(approved==6);
        ProtectedStore.CreateRoot();
        using var key=ProtectedStore.CreateKey(keyName,provider);
        using var signer=new ECDsaCng(key);
        // A partial failure intentionally leaves evidence and requires recovery;
        // it must never silently overwrite an old consent or revoked generation.
        g=g with {IssuerSpkiSha256=Protocol.Hash(signer.ExportSubjectPublicKeyInfo()),
            ConsentedAtMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};
        var config=new StoreConfig(1,request.OwnerSid,request.DeviceId,request.InstallationId,
            request.OwnerAccountId,keyName,provider,request.AuthoritySpkiBase64);
        ProtectedStore.WriteNew("config.json",config);
        ProtectedStore.WriteNew("grant.json",new SignedGrant(g,Convert.ToBase64String(signer.SignData(
            Protocol.GrantBytes(g),HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation))));
        ProtectedStore.Load();
        Console.WriteLine("LOCAL_ENROLLMENT_SAVED");
    }
}
