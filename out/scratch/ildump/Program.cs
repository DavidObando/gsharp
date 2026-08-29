using System;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

var path = args[0];
var typeSubstr = args.Length > 1 ? args[1] : null;
var methodSubstr = args.Length > 2 ? args[2] : "MoveNext";

using var fs = File.OpenRead(path);
using var pe = new PEReader(fs);
var reader = pe.GetMetadataReader();

foreach (var typeHandle in reader.TypeDefinitions)
{
    var type = reader.GetTypeDefinition(typeHandle);
    var typeName = reader.GetString(type.Name);
    if (typeSubstr != null && !typeName.Contains(typeSubstr, StringComparison.OrdinalIgnoreCase))
    {
        continue;
    }

    foreach (var methodHandle in type.GetMethods())
    {
        var method = reader.GetMethodDefinition(methodHandle);
        var methodName = reader.GetString(method.Name);
        if (!methodName.Contains(methodSubstr, StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }

        if (method.RelativeVirtualAddress == 0)
        {
            continue;
        }

        Console.WriteLine($"=== {typeName}::{methodName} ===");
        var body = pe.GetMethodBody(method.RelativeVirtualAddress);
        var il = body.GetILContent();
        Dump(reader, il);
    }
}

static void Dump(MetadataReader reader, System.Collections.Immutable.ImmutableArray<byte> il)
{
    int i = 0;
    while (i < il.Length)
    {
        int offset = i;
        byte b = il[i++];
        string mnemonic;
        int operandSize = 0;
        bool isTwoByte = false;

        if (b == 0xFE)
        {
            isTwoByte = true;
            byte b2 = il[i++];
            (mnemonic, operandSize) = TwoByteOp(b2);
        }
        else
        {
            (mnemonic, operandSize) = OneByteOp(b);
        }

        string operandStr = "";
        if (operandSize == 4)
        {
            int val = BitConverter.ToInt32(il.AsSpan(i, 4));
            operandStr = TryResolveToken(reader, val);
            i += 4;
        }
        else if (operandSize == 1)
        {
            operandStr = ((sbyte)il[i]).ToString();
            i += 1;
        }
        else if (operandSize == 8)
        {
            operandStr = BitConverter.ToInt64(il.AsSpan(i, 8)).ToString();
            i += 8;
        }
        else if (operandSize == -1)
        {
            // switch: not handling fully
        }

        Console.WriteLine($"IL_{offset:X4}: {mnemonic} {operandStr}");
    }
}

static string TryResolveToken(MetadataReader reader, int val)
{
    try
    {
        var handle = MetadataTokens.EntityHandle(val);
        switch (handle.Kind)
        {
            case HandleKind.MemberReference:
                var mr = reader.GetMemberReference((MemberReferenceHandle)handle);
                var mrName = reader.GetString(mr.Name);
                var parent = ResolveTypeRefName(reader, mr.Parent);
                return $"[{parent}::{mrName}] (0x{val:X8})";
            case HandleKind.MethodDefinition:
                var md = reader.GetMethodDefinition((MethodDefinitionHandle)handle);
                return $"[{reader.GetString(md.Name)}] (0x{val:X8})";
            case HandleKind.TypeReference:
                return $"[{ResolveTypeRefName(reader, handle)}] (0x{val:X8})";
            case HandleKind.TypeDefinition:
                var td = reader.GetTypeDefinition((TypeDefinitionHandle)handle);
                return $"[{reader.GetString(td.Name)}] (0x{val:X8})";
            case HandleKind.TypeSpecification:
                return $"[TypeSpec] (0x{val:X8})";
            case HandleKind.FieldDefinition:
                var fd = reader.GetFieldDefinition((FieldDefinitionHandle)handle);
                return $"[{reader.GetString(fd.Name)}] (0x{val:X8})";
            case HandleKind.String:
                return "\"" + reader.GetUserString(MetadataTokens.UserStringHandle(val)) + "\"";
            default:
                return $"(0x{val:X8})";
        }
    }
    catch
    {
        return $"token(0x{val:X8})";
    }
}

static string ResolveTypeRefName(MetadataReader reader, EntityHandle handle)
{
    try
    {
        if (handle.Kind == HandleKind.TypeReference)
        {
            var tr = reader.GetTypeReference((TypeReferenceHandle)handle);
            return reader.GetString(tr.Namespace) + "." + reader.GetString(tr.Name);
        }
        if (handle.Kind == HandleKind.TypeDefinition)
        {
            var td = reader.GetTypeDefinition((TypeDefinitionHandle)handle);
            return reader.GetString(td.Namespace) + "." + reader.GetString(td.Name);
        }
        if (handle.Kind == HandleKind.TypeSpecification)
        {
            return "TypeSpec";
        }
    }
    catch { }
    return "?";
}

static (string, int) OneByteOp(byte b) => b switch
{
    0x00 => ("nop", 0),
    0x01 => ("break", 0),
    0x02 => ("ldarg.0", 0),
    0x03 => ("ldarg.1", 0),
    0x04 => ("ldarg.2", 0),
    0x05 => ("ldarg.3", 0),
    0x06 => ("ldloc.0", 0),
    0x07 => ("ldloc.1", 0),
    0x08 => ("ldloc.2", 0),
    0x09 => ("ldloc.3", 0),
    0x0A => ("stloc.0", 0),
    0x0B => ("stloc.1", 0),
    0x0C => ("stloc.2", 0),
    0x0D => ("stloc.3", 0),
    0x0E => ("ldarg.s", 1),
    0x0F => ("ldarga.s", 1),
    0x10 => ("starg.s", 1),
    0x11 => ("ldloc.s", 1),
    0x12 => ("ldloca.s", 1),
    0x13 => ("stloc.s", 1),
    0x14 => ("ldnull", 0),
    0x15 => ("ldc.i4.m1", 0),
    0x16 => ("ldc.i4.0", 0),
    0x17 => ("ldc.i4.1", 0),
    0x18 => ("ldc.i4.2", 0),
    0x19 => ("ldc.i4.3", 0),
    0x1A => ("ldc.i4.4", 0),
    0x1B => ("ldc.i4.5", 0),
    0x1C => ("ldc.i4.6", 0),
    0x1D => ("ldc.i4.7", 0),
    0x1E => ("ldc.i4.8", 0),
    0x1F => ("ldc.i4.s", 1),
    0x20 => ("ldc.i4", 4),
    0x21 => ("ldc.i8", 8),
    0x25 => ("dup", 0),
    0x26 => ("pop", 0),
    0x27 => ("jmp", 4),
    0x28 => ("call", 4),
    0x29 => ("calli", 4),
    0x2A => ("ret", 0),
    0x2B => ("br.s", 1),
    0x2C => ("brfalse.s", 1),
    0x2D => ("brtrue.s", 1),
    0x2E => ("beq.s", 1),
    0x2F => ("bge.s", 1),
    0x30 => ("bgt.s", 1),
    0x31 => ("ble.s", 1),
    0x32 => ("blt.s", 1),
    0x38 => ("br", 4),
    0x39 => ("brfalse", 4),
    0x3A => ("brtrue", 4),
    0x3B => ("beq", 4),
    0x45 => ("switch", -1),
    0x46 => ("ldind.i1", 0),
    0x58 => ("add", 0),
    0x59 => ("sub", 0),
    0x61 => ("conv.i", 0),
    0x67 => ("conv.i4", 0),
    0x6F => ("callvirt", 4),
    0x70 => ("cpobj", 4),
    0x71 => ("ldobj", 4),
    0x72 => ("ldstr", 4),
    0x73 => ("newobj", 4),
    0x74 => ("castclass", 4),
    0x75 => ("isinst", 4),
    0x7B => ("ldfld", 4),
    0x7C => ("ldflda", 4),
    0x7D => ("stfld", 4),
    0x7E => ("ldsfld", 4),
    0x7F => ("ldsflda", 4),
    0x80 => ("stsfld", 4),
    0x81 => ("stobj", 4),
    0x8C => ("box", 4),
    0x8D => ("newarr", 4),
    0x8E => ("ldlen", 0),
    0xA5 => ("unbox.any", 4),
    0xD0 => ("ldtoken", 4),
    0xFE => ("(2byte)", 0),
    _ => ($"unk_{b:X2}", 0),
};

static (string, int) TwoByteOp(byte b2) => b2 switch
{
    0x01 => ("ceq", 0),
    0x02 => ("cgt", 0),
    0x04 => ("clt", 0),
    0x06 => ("ldftn", 4),
    0x0C => ("ldarg", 2),
    0x0D => ("ldarga", 2),
    0x0E => ("starg", 2),
    0x0F => ("ldloc", 2),
    0x10 => ("ldloca", 2),
    0x11 => ("stloc", 2),
    0x15 => ("initobj", 4),
    _ => ($"unk_fe_{b2:X2}", 0),
};
