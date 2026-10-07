// Issue #4631 (C3): hashes the complete PE image with only the precise #GUID
// heap slot referenced by Module.Mvid zeroed. This fail-closed contract retains
// headers, metadata, method bodies, resources and debug-wrapper data. It is
// intentionally separate from RefactoringBaselineTests' IL-only body hash.
//
// usage: dotnet run build/selfhost/PeContentHash.cs -- <assembly.dll>...
// prints: <hex sha256>  <methods-with-body>  <path>
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;

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
    GuidHandle mvidHandle = reader.GetModuleDefinition().Mvid;
    int mvidOffset = FindGuidHeapOffset(bytes, pe, MetadataTokens.GetHeapOffset(mvidHandle));
    byte[] mvid = reader.GetGuid(mvidHandle).ToByteArray();
    if (!bytes.AsSpan(mvidOffset, mvid.Length).SequenceEqual(mvid))
    {
        throw new BadImageFormatException("Module.Mvid does not match its referenced #GUID slot");
    }
    bytes.AsSpan(mvidOffset, mvid.Length).Clear();
    using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
    sha.AppendData(bytes);
    int methods = 0;
    foreach (MethodDefinitionHandle handle in reader.MethodDefinitions)
    {
        methods += reader.GetMethodDefinition(handle).RelativeVirtualAddress == 0 ? 0 : 1;
    }

    Console.WriteLine($"{Convert.ToHexString(sha.GetHashAndReset())}  {methods}  {path}");
}

return 0;

static int FindGuidHeapOffset(byte[] image, PEReader pe, int guidIndex)
{
    int metadataStart = pe.PEHeaders.MetadataStartOffset;
    ReadOnlySpan<byte> metadata = image.AsSpan(metadataStart, pe.PEHeaders.MetadataSize);
    if (metadata.Length < 20 || metadata[0] != (byte)'B' || metadata[1] != (byte)'S'
        || metadata[2] != (byte)'J' || metadata[3] != (byte)'B')
    {
        throw new BadImageFormatException("invalid metadata root");
    }

    int versionLength = checked((int)BitConverter.ToUInt32(metadata.Slice(12, 4)));
    int cursor = checked(16 + versionLength);
    if (cursor + 4 > metadata.Length)
    {
        throw new BadImageFormatException("invalid metadata version length");
    }
    int streams = BitConverter.ToUInt16(metadata.Slice(cursor + 2, 2));
    cursor += 4;
    for (int index = 0; index < streams; index++)
    {
        if (cursor + 8 > metadata.Length)
        {
            throw new BadImageFormatException("truncated metadata stream header");
        }
        int offset = checked((int)BitConverter.ToUInt32(metadata.Slice(cursor, 4)));
        int size = checked((int)BitConverter.ToUInt32(metadata.Slice(cursor + 4, 4)));
        cursor += 8;
        int nameEnd = metadata.Slice(cursor).IndexOf((byte)0);
        if (nameEnd < 0)
        {
            throw new BadImageFormatException("unterminated metadata stream name");
        }
        string name = Encoding.ASCII.GetString(metadata.Slice(cursor, nameEnd));
        cursor = checked(cursor + ((nameEnd + 1 + 3) & ~3));
        if (name != "#GUID")
        {
            continue;
        }
        int guidOffset = checked((guidIndex - 1) * 16);
        if (guidIndex <= 0 || guidOffset + 16 > size || offset < 0 || offset + size > metadata.Length)
        {
            throw new BadImageFormatException(
                $"Module.Mvid index {guidIndex} is outside the #GUID stream ({size} bytes)");
        }
        return checked(metadataStart + offset + guidOffset);
    }
    throw new BadImageFormatException("metadata has no #GUID stream");
}
