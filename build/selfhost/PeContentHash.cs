// Issue #4631 (C3): hashes the parts of an assembly that the self-host
// equivalence gate compares: the metadata stream with every copy of the MVID
// zeroed, then each complete method body in MethodDef order (header, IL and
// exception regions). This is stronger than RefactoringBaselineTests' IL-only
// body hash; those existing baseline hashes are intentionally unchanged. The PE
// wrapper (headers, debug directory, checksum, timestamp) is excluded: it is
// derived from these bytes under deterministic emit.
//
// usage: dotnet run build/selfhost/PeContentHash.cs -- <assembly.dll>...
// prints: <hex sha256>  <methods-with-body>  <path>
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;

if (args.Length == 0)
{
    Console.Error.WriteLine("usage: PeContentHash <assembly.dll>... | --il-offset <assembly.dll>");
    return 2;
}

// Test support: the file offset of the first IL byte of the first method
// with a tiny body header, so a test can change IL without touching metadata.
if (args[0] == "--il-offset" && args.Length == 2)
{
    using var probe = new PEReader(File.OpenRead(args[1]));
    MetadataReader probeReader = probe.GetMetadataReader();
    foreach (MethodDefinitionHandle handle in probeReader.MethodDefinitions)
    {
        int rva = probeReader.GetMethodDefinition(handle).RelativeVirtualAddress;
        if (rva == 0)
        {
            continue;
        }

        MethodBodyBlock body = probe.GetMethodBody(rva);
        byte[]? il = body.GetILBytes();
        if (il is not { Length: > 1 } || body.Size != il.Length + 1)
        {
            continue;
        }

        foreach (SectionHeader section in probe.PEHeaders.SectionHeaders)
        {
            if (rva >= section.VirtualAddress && rva < section.VirtualAddress + section.VirtualSize)
            {
                Console.WriteLine(rva - section.VirtualAddress + section.PointerToRawData + 1);
                return 0;
            }
        }
    }

    Console.Error.WriteLine("no tiny-header method body found");
    return 1;
}

foreach (string path in args)
{
    byte[] bytes = File.ReadAllBytes(path);
    using var pe = new PEReader(new MemoryStream(bytes, writable: false));
    MetadataReader reader = pe.GetMetadataReader();
    using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

    int start = pe.PEHeaders.MetadataStartOffset;
    byte[] metadata = bytes.AsSpan(start, pe.PEHeaders.MetadataSize).ToArray();
    Guid mvid = reader.GetGuid(reader.GetModuleDefinition().Mvid);
    if (mvid != Guid.Empty)
    {
        byte[] needle = mvid.ToByteArray();
        for (int at = metadata.AsSpan().IndexOf(needle); at >= 0;)
        {
            metadata.AsSpan(at, needle.Length).Clear();
            int next = metadata.AsSpan(at + needle.Length).IndexOf(needle);
            at = next < 0 ? -1 : at + needle.Length + next;
        }
    }

    sha.AppendData(metadata);
    int methods = 0;
    foreach (MethodDefinitionHandle handle in reader.MethodDefinitions)
    {
        int rva = reader.GetMethodDefinition(handle).RelativeVirtualAddress;
        if (rva == 0)
        {
            continue;
        }

        MethodBodyBlock body = pe.GetMethodBody(rva);
        sha.AppendData(pe.GetSectionData(rva).GetContent(0, body.Size).AsSpan());
        methods++;
    }

    Console.WriteLine($"{Convert.ToHexString(sha.GetHashAndReset())}  {methods}  {path}");
}

return 0;
