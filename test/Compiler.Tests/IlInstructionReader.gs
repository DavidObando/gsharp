// <copyright file="IlInstructionReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Reflection.Emit

internal shared class IlInstructionReader {
    private let OpCodesByValue Dictionary[int16, OpCode] = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where((field FieldInfo) -> field.FieldType == typeof(OpCode))
        .Select((field FieldInfo) -> OpCode(field.GetValue(nil)!!))
        .ToDictionary((opcode OpCode) -> opcode.Value)

    func Read(il[]?uint8)[]IlInstruction {
        let instructions = List[IlInstruction]()
        var offset = 0
        while offset < il!!.Length {
            let instructionOffset = offset
            let value = if il!![offset++] == uint8(0xFE) {
                unchecked(int16((0xFE00 | int32(il!![offset++]))))
            } else {
                unchecked(int16(il!![instructionOffset]))
            }
            let opcode = OpCodesByValue[value]
            var branchTarget int32? = nil
            var metadataToken int32? = nil
            switch opcode.OperandType {
                case OperandType.InlineNone { }
                case OperandType.ShortInlineBrTarget {
                    branchTarget = offset + 1 + int32(unchecked(int8(il!![offset])))
                    offset++
                }
                case OperandType.InlineBrTarget {
                    branchTarget = offset + 4 + BitConverter.ToInt32(il!!, offset)
                    offset += 4
                }
                case OperandType.InlineSwitch {
                    let count = BitConverter.ToInt32(il!!, offset)
                    offset += 4 + (count * 4)
                }
                case OperandType.ShortInlineI, OperandType.ShortInlineVar {
                    offset++
                }
                case OperandType.InlineVar {
                    offset += 2
                }
                case OperandType.InlineMethod {
                    metadataToken = BitConverter.ToInt32(il!!, offset)
                    offset += 4
                }
                case OperandType.InlineI,
                OperandType.ShortInlineR,
                OperandType.InlineField,
                OperandType.InlineSig,
                OperandType.InlineString,
                OperandType.InlineTok,
                OperandType.InlineType {
                    offset += 4
                }
                case OperandType.InlineI8, OperandType.InlineR {
                    offset += 8
                }
                default {
                    throw InvalidOperationException("Unsupported IL operand type ${opcode.OperandType}.")
                }
            }
            instructions.Add(IlInstruction(instructionOffset, opcode, branchTarget, metadataToken))
        }
        return instructions.ToArray()
    }
}

internal data class IlInstruction(Offset int32, OpCode OpCode, BranchTarget int32?, MetadataToken int32?) : IEquatable[
    IlInstruction
] { }
