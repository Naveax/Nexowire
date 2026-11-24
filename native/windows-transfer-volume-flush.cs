// Build into a separately signed, ACL-protected executable. No raw volume
// writes, dismount, locks, shell commands, or automatic elevation.
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal static class TransferVolumeFlush
{
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool GetVolumePathNameW(string path, StringBuilder root, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool GetVolumeInformationW(string root, StringBuilder name, uint nameLength,
        out uint serial, out uint maxComponent, out uint flags, StringBuilder filesystem, uint filesystemLength);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
        uint creation, uint attributes, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool FlushFileBuffers(SafeFileHandle handle);

    static int Main(string[] args)
    {
        try {
            // This first provider intentionally supports only the local fixed C:
            // NTFS volume. Mounted folders, UNC, device aliases, ADS and reparse
            // directories are rejected, never silently mapped to another volume.
            if (args.Length != 1 || !args[0].StartsWith(@"C:\", StringComparison.OrdinalIgnoreCase)
                || args[0].IndexOf(':', 2) >= 0 || args[0].IndexOf('/') >= 0
                || !String.Equals(Path.GetFullPath(args[0]), args[0], StringComparison.OrdinalIgnoreCase)
                || !Directory.Exists(args[0])) return 2;
            for (DirectoryInfo d = new DirectoryInfo(args[0]); d != null; d = d.Parent)
                if ((d.Attributes & FileAttributes.ReparsePoint) != 0) return 2;
            StringBuilder root = new StringBuilder(260), fs = new StringBuilder(32);
            uint serial, maxComponent, flags;
            if (!GetVolumePathNameW(args[0], root, (uint)root.Capacity)
                || !String.Equals(root.ToString(), @"C:\", StringComparison.OrdinalIgnoreCase)
                || GetDriveTypeW(root.ToString()) != 3
                || !GetVolumeInformationW(root.ToString(), null, 0, out serial, out maxComponent, out flags, fs, (uint)fs.Capacity)
                || !String.Equals(fs.ToString(), "NTFS", StringComparison.OrdinalIgnoreCase)) return 3;
            // Windows documents FlushFileBuffers on a volume handle for
            // flushing its open files. Requires existing administrative rights.
            // GENERIC_WRITE, FILE_SHARE_READ|FILE_SHARE_WRITE, OPEN_EXISTING.
            using (SafeFileHandle volume = CreateFileW(@"\\.\C:", 0x40000000u, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
                if (volume.IsInvalid || !FlushFileBuffers(volume)) return 4;
            }
            Console.WriteLine("NEXOWIRE_NTFS_VOLUME_FLUSH_OK");
            return 0;
        } catch { return 5; }
    }
}
