using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32;

namespace Nexowire.LocalEnrollment;

internal sealed record StoreConfig(int Version,string OwnerSid,string DeviceId,
    string InstallationId,string OwnerAccountId,string KeyName,string KeyProvider,
    string AuthoritySpkiBase64);

internal static class ProtectedStore
{
    internal static readonly string Root = Path.Combine(Environment.GetFolderPath(
        Environment.SpecialFolder.CommonApplicationData),"NexowireLocalEnrollment");
    private static string FileName(string name) => Path.Combine(Root,name);
    internal static void RequireAdministrator()
    {
        using var identity=WindowsIdentity.GetCurrent();
        Protocol.Require(new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator));
    }
    internal static void AssertPath(string path)
    {
        var item = new DirectoryInfo(path);
        for(DirectoryInfo? ancestor=item; ancestor is not null; ancestor=ancestor.Parent)
            Protocol.Require(ancestor.Exists && (ancestor.Attributes & FileAttributes.ReparsePoint) == 0);
        var acl=item.GetAccessControl(AccessControlSections.Owner|AccessControlSections.Access);
        Protocol.Require(acl.AreAccessRulesProtected);
        Protocol.Require(acl.GetOwner(typeof(SecurityIdentifier))?.Value is "S-1-5-18" or "S-1-5-32-544");
        var found = new HashSet<string>();
        foreach(FileSystemAccessRule ace in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
        {
            var who=ace.IdentityReference.Value;
            Protocol.Require(who is "S-1-5-18" or "S-1-5-32-544");
            Protocol.Require(!ace.IsInherited && ace.AccessControlType == AccessControlType.Allow &&
                ace.FileSystemRights == FileSystemRights.FullControl &&
                ace.InheritanceFlags == (InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit) &&
                ace.PropagationFlags == PropagationFlags.None && found.Add(who));
        }
        Protocol.Require(found.Count == 2);
    }
    internal static void CreateRoot()
    {
        RequireAdministrator();
        if(Directory.Exists(Root)) { AssertPath(Root); return; }
        var acl=new DirectorySecurity();
        acl.SetAccessRuleProtection(true,false);
        acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
        foreach(var sid in new[]{"S-1-5-18","S-1-5-32-544"})
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        // The ACL is applied during creation, before any state is written.
        FileSystemAclExtensions.CreateDirectory(acl,Root);
        AssertPath(Root);
    }
    private static void AssertFile(string path)
    {
        var info=new FileInfo(path);
        Protocol.Require(info.Exists && (info.Attributes & FileAttributes.ReparsePoint)==0 && info.Length<=16384);
        AssertFileAcl(info.GetAccessControl(AccessControlSections.Owner|AccessControlSections.Access));
    }
    private static void AssertFileAcl(FileSecurity acl)
    {
        Protocol.Require(acl.GetOwner(typeof(SecurityIdentifier))?.Value is "S-1-5-18" or "S-1-5-32-544");
        var found=new HashSet<string>();
        foreach(FileSystemAccessRule ace in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
        {
            Protocol.Require(ace.IdentityReference.Value is "S-1-5-18" or "S-1-5-32-544");
            Protocol.Require(ace.AccessControlType==AccessControlType.Allow &&
                ace.FileSystemRights==FileSystemRights.FullControl);
            found.Add(ace.IdentityReference.Value);
        }
        Protocol.Require(found.Count==2);
    }
    internal static T Read<T>(string name)
    { AssertPath(Root); var path=FileName(name); AssertFile(path); return Protocol.Read<T>(System.IO.File.ReadAllBytes(path)); }
    internal static void WriteNew(string name,object value)
    {
        AssertPath(Root);
        var bytes=JsonSerializer.SerializeToUtf8Bytes(value,Protocol.Json);
        Protocol.Require(bytes.Length<=16384);
        var tmp=FileName("pending-"+Guid.NewGuid().ToString("D"));
        try
        {
            using(var stream=new FileStream(tmp,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough))
            { stream.Write(bytes); stream.Flush(true); }
            AssertFile(tmp);
            // Never replace an existing grant, config, nonce or revocation.
            System.IO.File.Move(tmp,FileName(name),false);
        }
        finally { if(System.IO.File.Exists(tmp))System.IO.File.Delete(tmp); }
    }
    internal static string MachineBinding()
    {
        using var key=RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,RegistryView.Registry64)
            .OpenSubKey(@"SOFTWARE\Microsoft\Cryptography",false);
        var guid=key?.GetValue("MachineGuid") as string;
        Protocol.Require(Protocol.Uuid(guid));
        return Protocol.Hash(System.Text.Encoding.UTF8.GetBytes("nexowire.machine.binding.v2\0"+guid!.ToLowerInvariant()));
    }
    internal static CngKey OpenKey(StoreConfig c)
    {
        Protocol.Require(c.KeyProvider is "Microsoft Platform Crypto Provider" or "Microsoft Software Key Storage Provider");
        Protocol.Require(c.KeyName.StartsWith("Nexowire.LocalEnrollment.",StringComparison.Ordinal) &&
            Protocol.Uuid(c.KeyName[25..]));
        var key=CngKey.Open(c.KeyName,new CngProvider(c.KeyProvider),CngKeyOpenOptions.MachineKey);
        try
        {
            Protocol.Require(key.IsMachineKey && key.Algorithm==CngAlgorithm.ECDsaP256 && key.ExportPolicy==CngExportPolicies.None);
            AssertKeyAcl(key);
            return key;
        }
        catch { key.Dispose(); throw; }
    }
    internal static CngKey CreateKey(string name,string provider)
    {
        RequireAdministrator();
        var security=new RawSecurityDescriptor("O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)");
        var bytes=new byte[security.BinaryLength];security.GetBinaryForm(bytes,0);
        var creation=new CngKeyCreationParameters {
            Provider=new CngProvider(provider),ExportPolicy=CngExportPolicies.None,
            KeyCreationOptions=CngKeyCreationOptions.MachineKey,KeyUsage=CngKeyUsages.Signing
        };
        creation.Parameters.Add(new CngProperty("Security Descr",bytes,(CngPropertyOptions)5));
        var key=CngKey.Create(CngAlgorithm.ECDsaP256,name,creation);
        try{AssertKeyAcl(key);return key;}
        catch{try{key.Delete();}finally{key.Dispose();}throw;}
    }
    private static void AssertKeyAcl(CngKey key)
    {
        var rawSecurity=key.GetProperty("Security Descr",(CngPropertyOptions)5).GetValue()
            ?? throw new InvalidDataException("LOCAL_ENROLLMENT_REJECTED");
        var sd=new RawSecurityDescriptor(rawSecurity,0);
        Protocol.Require(sd.Owner?.Value is "S-1-5-18" or "S-1-5-32-544");
        Protocol.Require(sd.DiscretionaryAcl is not null && sd.DiscretionaryAcl.Count==2);
        var found=new HashSet<string>();
        foreach(GenericAce raw in sd.DiscretionaryAcl!)
        {
            Protocol.Require(raw is CommonAce);
            var ace=(CommonAce)raw;
            Protocol.Require(ace.AceQualifier==AceQualifier.AccessAllowed && !ace.IsCallback &&
                ace.AceFlags==AceFlags.None && ace.SecurityIdentifier.Value is "S-1-5-18" or "S-1-5-32-544");
            Protocol.Require(found.Add(ace.SecurityIdentifier.Value));
        }
        Protocol.Require(found.Count==2);
    }
    // A process-crash-safe kernel file-sharing fence for the local revoke
    // marker and an in-flight attestation. No secret or approval is stored in
    // the lock file. Only SYSTEM/Administrators can open it in production.
    internal static FileStream OpenExclusiveFence(string path,CancellationToken stop)
    {
        var elapsed=System.Diagnostics.Stopwatch.StartNew();
        while(true)
        {
            stop.ThrowIfCancellationRequested();
            try{return new FileStream(path,FileMode.OpenOrCreate,FileAccess.ReadWrite,
                FileShare.None,4096,FileOptions.WriteThrough);}
            catch(IOException) when(elapsed.Elapsed<TimeSpan.FromSeconds(5))
            {
                // Bounded, monotonic wait. A stuck or contested fence denies
                // admission; it never ignores a previous revoke.
                if(stop.WaitHandle.WaitOne(25))stop.ThrowIfCancellationRequested();
            }
        }
    }
    internal static FileStream AcquireRevocationFence(CancellationToken stop)
    {
        AssertPath(Root);
        var path=FileName("revocation-fence.lock");
        var handle=OpenExclusiveFence(path,stop);
        try
        {
            // FileShare.None prevents reopening by path to query its ACL.
            // Read the security descriptor through the *same* trusted
            // exclusive handle, preserving the lock and its object identity.
            Protocol.Require(!handle.SafeFileHandle.IsInvalid && handle.Length<=16384 &&
                (System.IO.File.GetAttributes(path)&FileAttributes.ReparsePoint)==0);
            AssertFileAcl(handle.GetAccessControl());
            return handle;
        }
        catch{handle.Dispose();throw;}
    }
    internal static void RequireNoRevocationMarker(string root)
    {
        // File.Exists can return false on access denied / I/O failure.
        // Enumeration throws instead of treating an inaccessible revoke
        // marker as absent; even malformed files or directories deny.
        Protocol.Require(!Directory.EnumerateFileSystemEntries(
            root,"revoked.json",SearchOption.TopDirectoryOnly).Any());
    }
    internal static (StoreConfig Config,SignedGrant Grant) Load()
    {
        AssertPath(Root);
        RequireNoRevocationMarker(Root);
        var c=Read<StoreConfig>("config.json");var g=Read<SignedGrant>("grant.json");
        Protocol.Require(c.Version==1 && c.OwnerSid==g.Payload.OwnerSid &&
            c.OwnerAccountId==g.Payload.OwnerAccountId && c.DeviceId==g.Payload.DeviceId &&
            c.InstallationId==g.Payload.InstallationId && g.Payload.MachineBindingSha256==MachineBinding());
        using var key=OpenKey(c);using var signer=new ECDsaCng(key);
        Protocol.Require(Protocol.Hash(signer.ExportSubjectPublicKeyInfo())==g.Payload.IssuerSpkiSha256 &&
            Protocol.Verify(signer,Protocol.GrantBytes(g.Payload),g.SignatureBase64));
        return(c,g);
    }
    internal static void ConsumeNonce(string nonce)
    {
        Protocol.Require(Protocol.Uuid(nonce));
        AssertPath(Root);
        // A crash or lost reply after this durable claim remains consumed.
        // Bound storage rather than discard replay protection on overload.
        Protocol.Require(Directory.EnumerateFiles(Root,"nonce-*.json").Take(100000).Count()<100000);
        WriteNew("nonce-"+nonce+".json",new {version=2,consumed=true});
    }
}
