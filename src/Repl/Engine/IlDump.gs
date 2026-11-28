// <copyright file="IlDump.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text

/// Decodes emitted PE method bodies into readable IL listings for `:show il`.
internal shared class IlDump {
    private let opCodes Dictionary[int16, OpCode] = BuildOpCodes()

    func Create(image[]uint8) string {
        using let stream = MemoryStream(image, writable: false)
        using let pe = PEReader(stream)
        let metadata = pe.GetMetadataReader()
        let text = StringBuilder()
        for handle in metadata.MethodDefinitions {
            let method = metadata.GetMethodDefinition(handle)
            if method.RelativeVirtualAddress == 0 {
                continue
            }
            let declaringType = metadata.GetTypeDefinition(method.GetDeclaringType())
            text
                .Append("method ")
                .Append(metadata.GetString(declaringType.Name))
                .Append("::")
                .Append(metadata.GetString(method.Name))
                .Append('\n')
            let ilBytes = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()
            if ilBytes != nil {
                AppendBody(text, ilBytes)
            }
        }
        return text.ToString()
    }

    private func BuildOpCodes() Dictionary[int16, OpCode] {
        let table = Dictionary[int16, OpCode]()
        for field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static) {
            if field.FieldType == typeof(OpCode) && field.GetValue(nil) is OpCode op {
                table[op.Value] = op
            }
        }
        return table
    }

    private func AppendBody(text StringBuilder, bytes[]uint8) {
        var offset = 0
        while offset < bytes.Length {
            let instructionOffset = offset
            let first = bytes[offset]
            offset += 1
            var value int16
            if first == uint8(0xfe) {
                if offset >= bytes.Length {
                    text
                        .Append("  IL_")
                        .Append(instructionOffset.ToString("X4", CultureInfo.InvariantCulture))
                        .Append(": <truncated>\n")
                    return
                }
                let second = bytes[offset]
                offset += 1
                value = int16(uint16(0xfe00) | uint16(second))
            } else {
                value = int16(first)
            }
            if !opCodes.TryGetValue(value, out var op) {
                text
                    .Append("  IL_")
                    .Append(instructionOffset.ToString("X4", CultureInfo.InvariantCulture))
                    .Append(": <unknown>\n")
                return
            }
            text
                .Append("  IL_")
                .Append(instructionOffset.ToString("X4", CultureInfo.InvariantCulture))
                .Append(": ")
                .Append(op.Name)
            AppendOperand(text, bytes, ref offset, op.OperandType)
            text.Append('\n')
        }
    }

    private func AppendOperand(text StringBuilder, bytes[]uint8, ref offset int32, operandType OperandType) {
        switch operandType {
            case OperandType.InlineNone {
                return
            }
            case OperandType.ShortInlineBrTarget {
                if offset >= bytes.Length {
                    return
                }
                let delta = int32(int8(bytes[offset]))
                text.Append(" IL_").Append((offset + 1 + delta).ToString("X4", CultureInfo.InvariantCulture))
                offset += 1
                return
            }
            case OperandType.InlineBrTarget {
                if offset + 4 > bytes.Length {
                    return
                }
                text.Append(" IL_").Append(
                    (offset + 4 + BitConverter.ToInt32(bytes, offset)).ToString("X4", CultureInfo.InvariantCulture)
                )
                offset += 4
                return
            }
            case OperandType.InlineSwitch {
                if offset + 4 > bytes.Length {
                    return
                }
                let count = BitConverter.ToInt32(bytes, offset)
                offset += 4 + (count * 4)
                text.Append(" (").Append(count.ToString(CultureInfo.InvariantCulture)).Append(" targets)")
                return
            }
            case OperandType.ShortInlineI {
                if offset >= bytes.Length {
                    return
                }
                text.Append(' ').Append(int8(bytes[offset]).ToString(CultureInfo.InvariantCulture))
                offset += 1
                return
            }
            case OperandType.ShortInlineVar {
                if offset >= bytes.Length {
                    return
                }
                text.Append(' ').Append(bytes[offset].ToString(CultureInfo.InvariantCulture))
                offset += 1
                return
            }
            case OperandType.InlineVar {
                if offset + 2 > bytes.Length {
                    return
                }
                text.Append(' ').Append(BitConverter.ToUInt16(bytes, offset).ToString(CultureInfo.InvariantCulture))
                offset += 2
                return
            }
            case OperandType.InlineI {
                if offset + 4 > bytes.Length {
                    return
                }
                text.Append(' ').Append(BitConverter.ToInt32(bytes, offset).ToString(CultureInfo.InvariantCulture))
                offset += 4
                return
            }
            case OperandType.ShortInlineR {
                if offset + 4 > bytes.Length {
                    return
                }
                text.Append(' ').Append(
                    BitConverter.ToSingle(bytes, offset).ToString("R", CultureInfo.InvariantCulture)
                )
                offset += 4
                return
            }
            case OperandType.InlineI8 {
                if offset + 8 > bytes.Length {
                    return
                }
                text.Append(' ').Append(BitConverter.ToInt64(bytes, offset).ToString(CultureInfo.InvariantCulture))
                offset += 8
                return
            }
            case OperandType.InlineR {
                if offset + 8 > bytes.Length {
                    return
                }
                text.Append(' ').Append(
                    BitConverter.ToDouble(bytes, offset).ToString("R", CultureInfo.InvariantCulture)
                )
                offset += 8
                return
            }
            default {
                if offset + 4 > bytes.Length {
                    return
                }
                text.Append(" 0x").Append(
                    BitConverter.ToInt32(bytes, offset).ToString("X8", CultureInfo.InvariantCulture)
                )
                offset += 4
                return
            }
        }
    }
}
