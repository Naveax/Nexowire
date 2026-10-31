using System.Security.Cryptography;
using System.Text.Json;

namespace Nexowire.LocalEnrollment;

internal static class SelfTest
{
    private static void VerifyFailClosedRevocationEntries()
    {
        // Isolated temp directory only: no real ProgramData/SCM/ACL/UAC.
        var root=Path.Combine(Path.GetTempPath(),"nexowire-ai02-revoke-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var marker=Path.Combine(root,"revoked.json");
        try
        {
            ProtectedStore.RequireNoRevocationMarker(root);
            File.WriteAllBytes(marker,new byte[]{0xff,0x00,0x01});
            var denied=false;
            try{ProtectedStore.RequireNoRevocationMarker(root);}
            catch(InvalidDataException){denied=true;}
            Protocol.Require(denied);
            File.Delete(marker);
            Directory.CreateDirectory(marker);
            denied=false;
            try{ProtectedStore.RequireNoRevocationMarker(root);}
            catch(InvalidDataException){denied=true;}
            Protocol.Require(denied);
        }
        finally{Directory.Delete(root,true);}
    }
    private static void VerifyStrictNativeWireText()
    {
        // Native '$' may match before the final newline, unlike JS
        // end-anchoring; canonical signed values must never differ.
        var grant=new Grant(2,"ES256-P1363","physical-console","diagnostic-owner-0001",
            "S-1-5-21-100-200-300-1001",
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            new string('a',64),new string('b',64),1,1700000000000,null);
        Protocol.Validate(grant);
        foreach(var bad in new[]{
            grant with { OwnerAccountId=grant.OwnerAccountId+"\n" },
            grant with { OwnerSid=grant.OwnerSid+"\n" },
            grant with { MachineBindingSha256=grant.MachineBindingSha256+"\n" },
            grant with { IssuerSpkiSha256=grant.IssuerSpkiSha256+"\n" }
        })
        {
            var denied=false;
            try{Protocol.Validate(bad);}
            catch(InvalidDataException){denied=true;}
            Protocol.Require(denied);
        }
        var session=new Session(2,new string('a',64),
            "44444444-4444-4444-8444-444444444444",
            "nexowire.local-enrollment.session",
            "55555555-5555-4555-8555-555555555555",
            1,grant.OwnerSid,"0000000000001234",1700000001000,1700000011000);
        Protocol.SessionBytes(session);
        foreach(var bad in new[]{
            session with { OwnerSid=session.OwnerSid+"\n" },
            session with { EnrollmentSha256=session.EnrollmentSha256+"\n" },
            session with { LogonLuid=session.LogonLuid+"\n" }
        })
        {
            var denied=false;
            try{Protocol.SessionBytes(bad);}
            catch(InvalidDataException){denied=true;}
            Protocol.Require(denied);
        }
    }
    private static void VerifyCorruptedProtectedRecordParser()
    {
        // Serializer-only store fixture. Does NOT touch protected ProgramData,
        // SCM, CNG keys, the real owner's grant or any local approval.
        var safe=new StoreConfig(1,"S-1-5-21-100-200-300-1001",
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "diagnostic-owner-0001",
            "Nexowire.LocalEnrollment.33333333-3333-4333-8333-333333333333",
            "Microsoft Software Key Storage Provider","dGVzdA==");
        var serialized=JsonSerializer.SerializeToUtf8Bytes(safe,Protocol.Json);
        Protocol.Require(Protocol.Read<StoreConfig>(serialized)==safe);
        foreach(var malformed in new byte[][]{
            Array.Empty<byte>(),
            new byte[]{0xff,0x00,0x01},
            new byte[16385],
            System.Text.Encoding.UTF8.GetBytes("{\"version\":1,\"version\":1}"),
            System.Text.Encoding.UTF8.GetBytes("{\"version\":1}"),
            System.Text.Encoding.UTF8.GetBytes("{\"version\":1,\"extra\":true}"),
            System.Text.Encoding.UTF8.GetBytes("{\"version\":")
        })
        {
            var rejected=false;
            try{Protocol.Read<StoreConfig>(malformed);}
            catch(Exception e) when(e is InvalidDataException or JsonException){rejected=true;}
            Protocol.Require(rejected);
        }
    }
    private static void VerifyIpcFraming()
    {
        // Strict parser-only contract tests. No SCM, pipe, grant or consent.
        const string goodStatus = """{"version":2,"verified":true,"mayDispatch":false,"grant":{},"spkiBase64":"dGVzdA==","keyProvider":"Microsoft Software Key Storage Provider","evidence":{},"witness":null}""";
        const string missingWitness = """{"version":2,"verified":true,"mayDispatch":false,"grant":{},"spkiBase64":"dGVzdA==","keyProvider":"Microsoft Software Key Storage Provider","evidence":{}}""";
        var goodAttest=goodStatus.Replace("\"witness\":null","\"witness\":{}");
        using(var accepted=JsonDocument.Parse(goodStatus))
            EnrollmentClient.RequireAcceptedFrame(accepted.RootElement,"status");
        using(var acceptedAttest=JsonDocument.Parse(goodAttest))
            EnrollmentClient.RequireAcceptedFrame(acceptedAttest.RootElement,"attest");
        foreach(var (json,operation) in new (string Json,string Operation)[]{
            (goodStatus.Replace("\"verified\":true","\"verified\":false"),"status"),
            (goodStatus.Replace("\"mayDispatch\":false","\"mayDispatch\":true"),"status"),
            (goodStatus.Replace("\"version\":2","\"version\":1"),"status"),
            (goodStatus.Replace("\"witness\":null","\"witness\":null,\"error\":\"REJECTED\""),"status"),
            (goodStatus.Replace("\"verified\":true","\"verified\":true,\"verified\":true"),"status"),
            (goodStatus.Replace("\"grant\":{}","\"grant\":{\"payload\":1,\"payload\":2}"),"status"),
            (goodStatus.Replace("\"witness\":null","\"witness\":null,\"coreActive\":true"),"status"),
            (goodStatus.Replace("\"keyProvider\":\"Microsoft Software Key Storage Provider\"",
                "\"keyProvider\":\"unknown-provider\""),"status"),
            (goodStatus.Replace("\"spkiBase64\":\"dGVzdA==\"","\"spkiBase64\":\"\""),"status"),
            (missingWitness,"status"),
            (goodAttest,"status"),
            (goodStatus,"attest"),
            (missingWitness,"attest")
        })
        {
            using var doc=JsonDocument.Parse(json);
            var rejected=false;
            try{EnrollmentClient.RequireAcceptedFrame(doc.RootElement,operation);}
            catch(InvalidDataException){rejected=true;}
            Protocol.Require(rejected);
        }
    }
    private static void VerifyConsoleSnapshotPolicy()
    {
        // Pure, synthetic facts only; no enrollment, WTS impersonation or
        // physical owner approval is performed by this self-test.
        Protocol.Require(WindowsSessionEvidence.ActiveLocalConsoleFacts(4,4u,0,0));
        foreach(var item in new (int Session,uint Console,short Protocol,int State)[]{
            (0,4u,0,0),(4,5u,0,0),(4,uint.MaxValue,0,0),
            (4,4u,2,0),(4,4u,0,4),(4,4u,0,1)
        })
            Protocol.Require(!WindowsSessionEvidence.ActiveLocalConsoleFacts(
                item.Session,item.Console,item.Protocol,item.State));
    }
    private static void VerifyFinalSessionFreshness()
    {
        // Deterministic, disposable OS-fact snapshot model. This does NOT
        // invoke WTS, approve enrollment or exercise a real SCM service.
        var now=1700000001000L;
        var original=new SessionEvidence("55555555-5555-4555-8555-555555555555",
            2,"S-1-5-21-100-200-300-1001","0000000000001234");
        var request=new Session(2,new string('a',64),"44444444-4444-4444-8444-444444444444",
            "nexowire.local-enrollment.session",original.BootId,original.WindowsSessionId,
            original.OwnerSid,original.LogonLuid,now,now+5000);
        Protocol.RequireFreshSession(request,original,original,now+1);
        foreach(var (changed,at) in new (SessionEvidence?,long)[]{
            (null,now+1),(original with { BootId=Guid.NewGuid().ToString("D") },now+1),
            (original with { WindowsSessionId=3 },now+1),
            (original with { LogonLuid="0000000000009999" },now+1),
            (original with { OwnerSid="S-1-5-18" },now+1),
            (original,now-1),(original,now+5000),(original,now+6000)
        })
        {
            var rejected=false;
            try{Protocol.RequireFreshSession(request,original,changed,at);}
            catch(InvalidDataException){rejected=true;}
            Protocol.Require(rejected);
        }
    }
    private static void VerifyDisposableExclusiveFence()
    {
        // Real Windows file sharing against an isolated temp root only.
        // No protected enrollment files, native service, UAC or owner grant.
        var root=Path.Combine(Path.GetTempPath(),"nexowire-ai02-fence-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var path=Path.Combine(root,"fence.lock");
            using(var first=ProtectedStore.OpenExclusiveFence(path,CancellationToken.None))
            {
                // ACL read must use this exact open handle, since a separate
                // FileInfo.GetAccessControl open can violate FileShare.None.
                var heldAcl=first.GetAccessControl();
                Protocol.Require(heldAcl.GetOwner(typeof(System.Security.Principal.SecurityIdentifier)) is not null);
                using var cancelled=new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
                var denied=false;
                try
                {
                    using var second=ProtectedStore.OpenExclusiveFence(path,cancelled.Token);
                }
                catch(OperationCanceledException){denied=true;}
                Protocol.Require(denied);
            }
            // Closing the handle, including a crashed process, releases the
            // kernel sharing constraint without deleting the durable marker.
            using var reopened=ProtectedStore.OpenExclusiveFence(path,CancellationToken.None);
        }
        finally{Directory.Delete(root,true);}
    }
    internal static void MachineKey()
    {
        ProtectedStore.RequireAdministrator();
        var name="Nexowire.LocalEnrollment."+Guid.NewGuid().ToString("D");
        using var key=ProtectedStore.CreateKey(name,"Microsoft Software Key Storage Provider");
        try
        {
            // No config, consent, grant, service or ProtectedStore.Root writes.
            // This only tests actual machine key custody and reopen semantics.
            var c=new StoreConfig(1,"","","","",name,"Microsoft Software Key Storage Provider","");
            using var reopened=ProtectedStore.OpenKey(c);using var signer=new ECDsaCng(reopened);
            var bytes=System.Text.Encoding.UTF8.GetBytes("nexowire.disposable.machine.key.diagnostic");
            var sig=signer.SignData(bytes,HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            Protocol.Require(signer.VerifyData(bytes,sig,HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
            var denied=false;try{reopened.Export(CngKeyBlobFormat.Pkcs8PrivateBlob);}catch(CryptographicException){denied=true;}
            Protocol.Require(denied);
            Console.WriteLine(JsonSerializer.Serialize(new {diagnosticOnly=true,machineKeyAclVerified=true,
                privateExportDenied=true,provider="software",humanEnrollment=false},Protocol.Json));
        }
        finally{key.Delete();}
    }
    internal static void Run()
    {
        VerifyCorruptedProtectedRecordParser();
        VerifyFailClosedRevocationEntries();
        VerifyStrictNativeWireText();
        VerifyIpcFraming();
        VerifyConsoleSnapshotPolicy();
        VerifyDisposableExclusiveFence();
        VerifyFinalSessionFreshness();
        // Disposable CURRENT USER diagnostic key only. Never invokes consent,
        // creates a machine grant, changes SCM, or touches ProtectedStore.Root.
        var name="Nexowire.Diagnostic."+Guid.NewGuid().ToString("D");
        using var key=CngKey.Create(CngAlgorithm.ECDsaP256,name,new CngKeyCreationParameters {
            Provider=CngProvider.MicrosoftSoftwareKeyStorageProvider,ExportPolicy=CngExportPolicies.None,
            KeyUsage=CngKeyUsages.Signing
        });
        try
        {
            using var signer=new ECDsaCng(key);
            var spki=signer.ExportSubjectPublicKeyInfo();
            var denied=false;try{key.Export(CngKeyBlobFormat.Pkcs8PrivateBlob);}catch(CryptographicException){denied=true;}
            Protocol.Require(denied);
            var grant=new Grant(2,"ES256-P1363","physical-console","diagnostic-owner-0001",
                "S-1-5-21-100-200-300-1001","11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333",
                new string('a',64),Protocol.Hash(spki),1,1700000000000,null);
            var bytes=Protocol.GrantBytes(grant);
            var signature=Convert.ToBase64String(signer.SignData(bytes,HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
            Protocol.Require(Protocol.Verify(signer,bytes,signature));
            Protocol.Require(!Protocol.Verify(signer,bytes,Convert.ToBase64String(new byte[64])));
            var session=new Session(2,Protocol.Hash(bytes),"44444444-4444-4444-8444-444444444444",
                "nexowire.local-enrollment.session","55555555-5555-4555-8555-555555555555",1,
                grant.OwnerSid,"0000000000001234",1700000001000,1700000011000);
            var sessionSig=Convert.ToBase64String(signer.SignData(Protocol.SessionBytes(session),HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
            var duplicateDenied=false;
            try{Protocol.Read<Session>(System.Text.Encoding.UTF8.GetBytes("{\"version\":2,\"version\":2}"));}
            catch(InvalidDataException){duplicateDenied=true;}Protocol.Require(duplicateDenied);
            Console.WriteLine(JsonSerializer.Serialize(new {diagnosticOnly=true,privateExportDenied=denied,
                localConsolePolicyTestsPassed=true,revocationFenceDiagnosticPassed=true,finalSessionFreshnessTestsPassed=true,
                revokeMarkerFailClosedDiagnosticPassed=true,strictWireTextDiagnosticPassed=true,corruptStoreParserDiagnosticPassed=true,
                spkiBase64=Convert.ToBase64String(spki),grant=new SignedGrant(grant,signature),
                session=new SignedSession(session,sessionSig)},Protocol.Json));
        }
        finally{key.Delete();}
    }
}
