using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;

namespace GSharp.Repl.Engine;

internal static class IlDump
{
    private static readonly Dictionary<short, OpCode> OpCodes = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(f => f.FieldType == typeof(OpCode))
        .Select(f => (OpCode)f.GetValue(null)!)
        .ToDictionary(op => op.Value);

    public static string Create(byte[] image)
    {
        using var stream = new MemoryStream(image, writable: false);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var text = new StringBuilder();
        foreach (var handle in metadata.MethodDefinitions)
        {
            var method = metadata.GetMethodDefinition(handle);
            if (method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            var type = metadata.GetTypeDefinition(method.GetDeclaringType());
            text.Append("method ")
                .Append(metadata.GetString(type.Name))
                .Append("::")
                .Append(metadata.GetString(method.Name))
                .Append('\n');
            AppendBody(text, pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes());
        }

        return text.ToString();
    }

    private static void AppendBody(StringBuilder text, byte[] bytes)
    {
        var offset = 0;
        while (offset < bytes.Length)
        {
            var instructionOffset = offset;
            short value = bytes[offset++] == 0xfe
                ? unchecked((short)(0xfe00 | bytes[offset++]))
                : unchecked((short)bytes[instructionOffset]);
            if (!OpCodes.TryGetValue(value, out var op))
            {
                text.Append("  IL_").Append(instructionOffset.ToString("X4", CultureInfo.InvariantCulture))
                    .Append(": <unknown>").Append('\n');
                return;
            }

            text.Append("  IL_").Append(instructionOffset.ToString("X4", CultureInfo.InvariantCulture))
                .Append(": ").Append(op.Name);
            AppendOperand(text, bytes, ref offset, op.OperandType);
            text.Append('\n');
        }
    }

    private static void AppendOperand(StringBuilder text, byte[] bytes, ref int offset, OperandType type)
    {
        switch (type)
        {
            case OperandType.InlineNone:
                return;
            case OperandType.ShortInlineBrTarget:
                text.Append(" IL_").Append((offset + 1 + unchecked((sbyte)bytes[offset])).ToString("X4", CultureInfo.InvariantCulture));
                offset++;
                return;
            case OperandType.InlineBrTarget:
                text.Append(" IL_").Append((offset + 4 + BitConverter.ToInt32(bytes, offset)).ToString("X4", CultureInfo.InvariantCulture));
                offset += 4;
                return;
            case OperandType.InlineSwitch:
                var count = BitConverter.ToInt32(bytes, offset);
                offset += 4 + (count * 4);
                text.Append(" (").Append(count.ToString(CultureInfo.InvariantCulture)).Append(" targets)");
                return;
            case OperandType.ShortInlineI:
                text.Append(' ').Append(unchecked((sbyte)bytes[offset]).ToString(CultureInfo.InvariantCulture));
                offset++;
                return;
            case OperandType.ShortInlineVar:
                text.Append(' ').Append(bytes[offset].ToString(CultureInfo.InvariantCulture));
                offset++;
                return;
            case OperandType.InlineVar:
                text.Append(' ').Append(BitConverter.ToUInt16(bytes, offset).ToString(CultureInfo.InvariantCulture));
                offset += 2;
                return;
            case OperandType.InlineI:
                text.Append(' ').Append(BitConverter.ToInt32(bytes, offset).ToString(CultureInfo.InvariantCulture));
                offset += 4;
                return;
            case OperandType.ShortInlineR:
                text.Append(' ').Append(BitConverter.ToSingle(bytes, offset).ToString("R", CultureInfo.InvariantCulture));
                offset += 4;
                return;
            case OperandType.InlineI8:
                text.Append(' ').Append(BitConverter.ToInt64(bytes, offset).ToString(CultureInfo.InvariantCulture));
                offset += 8;
                return;
            case OperandType.InlineR:
                text.Append(' ').Append(BitConverter.ToDouble(bytes, offset).ToString("R", CultureInfo.InvariantCulture));
                offset += 8;
                return;
            default:
                text.Append(" 0x").Append(BitConverter.ToInt32(bytes, offset).ToString("X8", CultureInfo.InvariantCulture));
                offset += 4;
                return;
        }
    }
}
