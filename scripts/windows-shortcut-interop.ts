// Use the Unicode Shell Link API explicitly. WScript.Shell's shortcut Save
// failed in the isolated Turkish-profile setup regression. Only the current
// user's shortcut is written; this helper neither launches nor elevates anything.
// https://learn.microsoft.com/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw
// https://learn.microsoft.com/windows/win32/api/objidl/nf-objidl-ipersistfile-save
export const windowsShortcutInterop = `
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class NexowireShortcut {
 [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface Link {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int n, IntPtr data, uint flags);
  void GetIDList(out IntPtr p);
  void SetIDList(IntPtr p);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int n);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string p);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int n);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string p);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int n);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string p);
  void GetHotkey(out short key);
  void SetHotkey(short key);
  void GetShowCmd(out int value);
  void SetShowCmd(int value);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int n, out int index);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int index);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, uint reserved);
  void Resolve(IntPtr window, uint flags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string p);
 }
 static object NewLink() { return Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"))); }
 public static void Save(string file, string target, string args, string directory) {
  Directory.CreateDirectory(Path.GetDirectoryName(file));
  object value = NewLink();
  try {
   Link link = (Link)value;
   link.SetPath(target); link.SetArguments(args); link.SetWorkingDirectory(directory);
   link.SetDescription("Connect this PC to Nexowire");
   ((IPersistFile)value).Save(file, true);
  } finally { Marshal.FinalReleaseComObject(value); }
  value = NewLink();
  try {
   ((IPersistFile)value).Load(file, 0);
   StringBuilder actualArgs = new StringBuilder(32768), actualDirectory = new StringBuilder(32768);
   ((Link)value).GetArguments(actualArgs, actualArgs.Capacity);
   ((Link)value).GetWorkingDirectory(actualDirectory, actualDirectory.Capacity);
   if (actualArgs.ToString() != args || actualDirectory.ToString() != directory)
    throw new IOException("Shortcut Unicode path readback failed.");
  } finally { Marshal.FinalReleaseComObject(value); }
 }
}
`.trim();
