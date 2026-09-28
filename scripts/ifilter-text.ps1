# Prints the text Windows' own PDF engine extracts from a PDF: the search filter (IFilter) that Windows.Data.Pdf.dll
# registers for .pdf ("Reader Search Handler"), which Windows Search / Explorer use to index PDFs. Independent of
# PDF.js and PDFium. Dev tool only (tests that use it skip without it).
#   powershell -File scripts\ifilter-text.ps1 -Pdf x.pdf [-Out x.txt]
# The text is written as UTF-8 to -Out (or to stdout).
param([Parameter(Mandatory = $true)][string]$Pdf, [string]$Out)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class EpdfIFilter {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROPSPEC { public uint ulKind; public IntPtr data; }
  [StructLayout(LayoutKind.Sequential)]
  public struct FULLPROPSPEC { public Guid guidPropSet; public PROPSPEC psProperty; }
  [StructLayout(LayoutKind.Sequential)]
  public struct STAT_CHUNK {
    public uint idChunk; public int breakType; public int flags; public uint locale;
    public FULLPROPSPEC attribute; public uint idChunkSource; public uint cwcStartSource; public uint cwcLenSource;
  }

  [ComImport, Guid("89BCB740-6119-101A-BCB7-00DD010655AF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFilter {
    [PreserveSig] int Init(uint grfFlags, uint cAttributes, IntPtr aAttributes, out uint pFlags);
    [PreserveSig] int GetChunk(out STAT_CHUNK pStat);
    [PreserveSig] int GetText(ref uint pcwcBuffer, [Out, MarshalAs(UnmanagedType.LPArray)] char[] awcBuffer);
    [PreserveSig] int GetValue(out IntPtr ppPropValue);
    [PreserveSig] int BindRegion(IntPtr origPos, ref Guid riid, out IntPtr ppunk);
  }

  [ComImport, Guid("00000109-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPersistStream {
    [PreserveSig] int GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    [PreserveSig] int Load(IntPtr pStm);
    [PreserveSig] int Save(IntPtr pStm, bool fClearDirty);
    [PreserveSig] int GetSizeMax(out long pcbSize);
  }

  [ComImport, Guid("b824b49d-22ac-4161-ac8a-9916e8fa3f7f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IInitializeWithStream {
    [PreserveSig] int Initialize(IntPtr pstream, uint grfMode);
  }

  [DllImport("query.dll", CharSet = CharSet.Unicode)]
  static extern int LoadIFilter(string pwcsPath, IntPtr pUnkOuter, out IntPtr ppIUnk);

  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateStreamOnFileEx(string pszFile, uint grfMode, uint dwAttributes, bool fCreate, IntPtr pstmTemplate, out IntPtr ppstm);

  // The filter Windows.Data.Pdf.dll registers for .pdf ("Reader Search Handler").
  static readonly Guid PdfFilter = new Guid("6C337B26-3E38-4F98-813B-FBA18BAB64F5");

  static IFilter Open(string path) {
    IntPtr unk;
    if (LoadIFilter(path, IntPtr.Zero, out unk) == 0) {
      IFilter lf = (IFilter)Marshal.GetObjectForIUnknown(unk);
      Marshal.Release(unk);
      return lf;
    }
    // The PDF filter only takes a stream (no IPersistFile), so LoadIFilter cannot open it: do it by hand.
    object o = Activator.CreateInstance(Type.GetTypeFromCLSID(PdfFilter));
    IntPtr stm;
    int hr = SHCreateStreamOnFileEx(path, 0x20 /* STGM_READ | STGM_SHARE_DENY_WRITE */, 0, false, IntPtr.Zero, out stm);
    if (hr != 0) throw new Exception("SHCreateStreamOnFileEx failed: 0x" + hr.ToString("X8"));
    try {
      IInitializeWithStream iws = o as IInitializeWithStream;
      if (iws != null) hr = iws.Initialize(stm, 0);
      else {
        IPersistStream ps = o as IPersistStream;
        if (ps == null) throw new Exception("The PDF filter takes neither IInitializeWithStream nor IPersistStream");
        hr = ps.Load(stm);
      }
      if (hr != 0) throw new Exception("Loading the PDF into the filter failed: 0x" + hr.ToString("X8"));
    } finally { Marshal.Release(stm); }
    return (IFilter)o;
  }

  public static string Extract(string path) {
    IFilter f = Open(path);
    int hr;
    uint flags;
    // IFILTER_INIT_CANON_PARAGRAPHS | HARD_LINE_BREAKS | CANON_HYPHENS | CANON_SPACES
    hr = f.Init(0x1 | 0x2 | 0x4 | 0x8, 0, IntPtr.Zero, out flags);
    if (hr != 0) throw new Exception("IFilter.Init failed: 0x" + hr.ToString("X8"));
    var sb = new StringBuilder();
    char[] buf = new char[4096];
    for (;;) {
      STAT_CHUNK chunk;
      hr = f.GetChunk(out chunk);
      if (hr != 0) break; // FILTER_E_END_OF_CHUNKS or an error
      if ((chunk.flags & 1) == 0) continue; // not text
      if (sb.Length > 0 && chunk.breakType != 0) sb.Append('\n');
      for (;;) {
        uint n = (uint)buf.Length;
        hr = f.GetText(ref n, buf);
        if (hr < 0) break; // FILTER_E_NO_MORE_TEXT
        sb.Append(buf, 0, (int)n);
        if (hr == 0x00041709) break; // FILTER_S_LAST_TEXT
      }
    }
    Marshal.ReleaseComObject(f);
    return sb.ToString();
  }
}
'@

$text = [EpdfIFilter]::Extract((Resolve-Path $Pdf).Path)
if ($Out) { [System.IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false))) }
else { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $text }
