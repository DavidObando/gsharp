// Regression fixtures: change only a fat header's max stack or a catch clause's
// existing TypeRef token in a real Release assembly, leaving metadata and IL intact.
using System.Buffers.Binary;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

byte[] image = File.ReadAllBytes(args[0]);
using var pe = new PEReader(new MemoryStream(image));
MetadataReader reader = pe.GetMetadataReader();
bool headerDone = false, ehDone = false;
foreach (MethodDefinitionHandle handle in reader.MethodDefinitions)
{
    int rva = reader.GetMethodDefinition(handle).RelativeVirtualAddress;
    if (rva == 0)
    {
        continue;
    }

    SectionHeader section = pe.PEHeaders.SectionHeaders.First(s =>
        rva >= s.VirtualAddress && rva < s.VirtualAddress + s.VirtualSize);
    int offset = rva - section.VirtualAddress + section.PointerToRawData;
    if ((image[offset] & 3) != 3)
    {
        continue;
    }

    if (!headerDone)
    {
        byte[] changed = image.ToArray();
        ushort stack = BinaryPrimitives.ReadUInt16LittleEndian(image.AsSpan(offset + 2));
        BinaryPrimitives.WriteUInt16LittleEndian(changed.AsSpan(offset + 2), checked((ushort)(stack + 1)));
        File.WriteAllBytes(Path.Combine(args[1], "header-only.dll"), changed);
        Console.WriteLine($"max-stack-only: offset {offset + 2}, {stack} -> {stack + 1}");
        headerDone = true;
    }

    MethodBodyBlock body = pe.GetMethodBody(rva);
    if ((image[offset] & 8) == 0 || ehDone)
    {
        continue;
    }

    int data = (offset + (image[offset + 1] >> 4) * 4 + body.GetILContent().Length + 3) & ~3;
    bool fat = (image[data] & 0x40) != 0;
    int size = fat ? image[data + 1] | image[data + 2] << 8 | image[data + 3] << 16 : image[data + 1];
    int stride = fat ? 24 : 12;
    for (int clause = data + 4; clause + stride <= data + size; clause += stride)
    {
        int flags = fat ? BinaryPrimitives.ReadInt32LittleEndian(image.AsSpan(clause)) :
            BinaryPrimitives.ReadUInt16LittleEndian(image.AsSpan(clause));
        if (flags != 0)
        {
            continue;
        }

        int tokenOffset = clause + (fat ? 20 : 8);
        int token = BinaryPrimitives.ReadInt32LittleEndian(image.AsSpan(tokenOffset));
        TypeReferenceHandle other = reader.TypeReferences.First(h => MetadataTokens.GetToken(h) != token &&
            reader.GetString(reader.GetTypeReference(h).Namespace) == "System" &&
            reader.GetString(reader.GetTypeReference(h).Name).EndsWith("Exception", StringComparison.Ordinal));
        byte[] changed = image.ToArray();
        BinaryPrimitives.WriteInt32LittleEndian(changed.AsSpan(tokenOffset), MetadataTokens.GetToken(other));
        File.WriteAllBytes(Path.Combine(args[1], "eh-only.dll"), changed);
        Console.WriteLine($"catch-type-only: offset {tokenOffset}, 0x{token:X8} -> 0x{MetadataTokens.GetToken(other):X8}");
        ehDone = true;
        break;
    }

    if (headerDone && ehDone)
    {
        return 0;
    }
}

Console.Error.WriteLine("could not produce both method-body mutants");
return 1;
