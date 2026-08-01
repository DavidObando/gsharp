// <copyright file="IlInstructionReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;

namespace GSharp.Compiler.Tests;

internal static class IlInstructionReader
{
    private static readonly Dictionary<short, OpCode> OpCodesByValue = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(field => field.FieldType == typeof(OpCode))
        .Select(field => (OpCode)field.GetValue(null)!)
        .ToDictionary(opcode => opcode.Value);

    public static IlInstruction[] Read(byte[] il)
    {
        var instructions = new List<IlInstruction>();
        var offset = 0;
        while (offset < il.Length)
        {
            var instructionOffset = offset;
            short value = il[offset++] == 0xFE
                ? unchecked((short)(0xFE00 | il[offset++]))
                : unchecked((short)il[instructionOffset]);
            var opcode = OpCodesByValue[value];
            int? branchTarget = null;
            int? metadataToken = null;

            switch (opcode.OperandType)
            {
                case OperandType.InlineNone:
                    break;
                case OperandType.ShortInlineBrTarget:
                    branchTarget = offset + 1 + unchecked((sbyte)il[offset]);
                    offset++;
                    break;
                case OperandType.InlineBrTarget:
                    branchTarget = offset + 4 + BitConverter.ToInt32(il, offset);
                    offset += 4;
                    break;
                case OperandType.InlineSwitch:
                    var count = BitConverter.ToInt32(il, offset);
                    offset += 4 + (count * 4);
                    break;
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                    offset++;
                    break;
                case OperandType.InlineVar:
                    offset += 2;
                    break;
                case OperandType.InlineMethod:
                    metadataToken = BitConverter.ToInt32(il, offset);
                    offset += 4;
                    break;
                case OperandType.InlineI:
                case OperandType.ShortInlineR:
                case OperandType.InlineField:
                case OperandType.InlineSig:
                case OperandType.InlineString:
                case OperandType.InlineTok:
                case OperandType.InlineType:
                    offset += 4;
                    break;
                case OperandType.InlineI8:
                case OperandType.InlineR:
                    offset += 8;
                    break;
                default:
                    throw new InvalidOperationException($"Unsupported IL operand type {opcode.OperandType}.");
            }

            instructions.Add(new IlInstruction(instructionOffset, opcode, branchTarget, metadataToken));
        }

        return instructions.ToArray();
    }
}

internal sealed record IlInstruction(
    int Offset,
    OpCode OpCode,
    int? BranchTarget,
    int? MetadataToken);
