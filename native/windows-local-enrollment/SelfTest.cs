using System.Security.Cryptography;
using System.Text.Json;

namespace Nexowire.LocalEnrollment;

internal static class SelfTest
{
    private static void VerifyIpcFraming()
    {
        // Disposable parser-only tests: no SCM, pipe, grant or user approval.
        using(var accepted=JsonDocument.Parse("""{"version":2,"verified":true,"mayDispatch":false,"grant":{},"evidence":{}}"""))
            EnrollmentClient.RequireAcceptedFrame(accepted.RootElement,"status");
        using(var acceptedAttest=JsonDocument.Parse("""{"version":2,"verified":true,"mayDispatch":false,"grant":{},"evidence":{},"witness":{}}"""))
            EnrollmentClient.RequireAcceptedFrame(acceptedAttest.RootElement,"attest");
        foreach(var input in new[]{
            """{"version":2,"verified":false,"mayDispatch":false,"grant":{},"evidence":{}}""",
            """{"version":2,"verified":true,"mayDispatch":true,"grant":{},"evidence":{}}""",
            """{"version":1,"verified":true,"mayDispatch":false,"grant":{},"evidence":{}}""",
            """{"version":2,"verified":true,"mayDispatch":false,"grant":{},"evidence":{},"error":"LOCAL_ENROLLMENT_REJECTED"}""",
            """{"version":2,"verified":true,"mayDispatch":false,"grant":{}}"""
        })
        {
            using var doc=JsonDocument.Parse(input);
            var denied=false;
            try{EnrollmentClient.RequireAcceptedFrame(doc.RootElement,"status");}
            catch(InvalidDataException){denied=true;}
            Protocol.Require(denied);
        }
        foreach(var input in new[]{
            """{"version":2,"verified":true,"mayDispatch":false,"grant":{},"evidence":{},"witness":null}""",
            """{"version":2,"verified":true,"mayDispatch":false,"grant":{},"evidence":{}}"""
        })
        {
            using var doc=JsonDocument.Parse(input);
            var denied=false;
            try{EnrollmentClient.RequireAcceptedFrame(doc.RootElement,"attest");}
            catch(InvalidDataException){denied=true;}
            Protocol.Require(denied);
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
        VerifyIpcFraming();
        VerifyConsoleSnapshotPolicy();
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
                localConsolePolicyTestsPassed=true,spkiBase64=Convert.ToBase64String(spki),grant=new SignedGrant(grant,signature),
                session=new SignedSession(session,sessionSig)},Protocol.Json));
        }
        finally{key.Delete();}
    }
}
