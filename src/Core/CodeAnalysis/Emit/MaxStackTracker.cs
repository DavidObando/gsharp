// <copyright file="MaxStackTracker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Computes the <c>.maxstack</c> value (maximum evaluation-stack depth) for an
/// emitted method body so that <see
/// cref="System.Reflection.Metadata.Ecma335.MethodBodyStreamEncoder.AddMethodBody(InstructionEncoder, int, StandaloneSignatureHandle, MethodBodyAttributes, bool)"/>
/// no longer falls back to the format default of <c>8</c> (issue #1490).
/// </summary>
/// <remarks>
/// <para>
/// The naïve default of 8 produces <em>invalid IL</em> for any body whose
/// evaluation-stack peak exceeds eight slots (a call/constructor with many
/// arguments, a deeply nested arithmetic expression, an async
/// <c>MoveNext</c> state machine, …). <c>ilverify</c> rejects such bodies
/// with <c>StackOverflow</c> because the computed depth exceeds the declared
/// <c>.maxstack</c>.
/// </para>
/// <para>
/// A <em>precise</em> peak cannot be recovered from the emitted IL bytes
/// alone: <c>call</c>/<c>callvirt</c>/<c>newobj</c>/<c>calli</c> are
/// <c>varpop</c> — their pop count depends on the callee signature, which is
/// not encoded in the opcode stream. gsc emits these instructions from ~40
/// scattered sites (some via <c>il.Call(handle)</c>, some via
/// <c>il.OpCode(Callvirt)+il.Token(handle)</c>), so threading the per-call
/// argument count through every site would be invasive and error-prone.
/// </para>
/// <para>
/// Instead this helper computes a <strong>provably-correct upper bound</strong>
/// on the peak that is independent of control flow and of the
/// (unknown) call pop counts: the sum, over every emitted instruction, of the
/// number of values that instruction <em>pushes</em>. Because every IL
/// instruction has a net stack delta of at most <c>+1</c> (even <c>dup</c>,
/// which pops one and pushes two), and verifiable IL has a single, path-
/// independent stack height at each offset, the height at any reachable
/// offset equals the sum of net deltas along a simple (acyclic) path to it,
/// which never exceeds the total number of pushes in the body. The bound is
/// therefore guaranteed to be ≥ the true peak and is never an
/// under-estimate, so the emitted <c>.maxstack</c> is always valid.
/// <c>varpop</c> call instructions are counted as pushing one value (their
/// maximum), which keeps the bound conservative without needing the callee
/// argument count.
/// </para>
/// </remarks>
internal static class MaxStackTracker
{
    // Per-opcode decode table: operand byte size (excluding the opcode itself)
    // and the number of values the opcode pushes onto the evaluation stack.
    // Keyed by the encoded opcode value (single-byte opcodes 0x00..0xFF; two-
    // byte 0xFE-prefixed opcodes keyed as unchecked((short)(0xFE00 | second))).
    private static readonly Dictionary<short, OpCodeInfo> Table = BuildTable();

    /// <summary>
    /// Computes a valid <c>.maxstack</c> upper bound for the body currently
    /// accumulated in <paramref name="il"/>.
    /// </summary>
    /// <param name="il">The instruction encoder holding the emitted IL.</param>
    /// <returns>
    /// The maximum evaluation-stack depth to declare, clamped to the
    /// <see cref="ushort"/> range permitted by the metadata format.
    /// </returns>
    public static int ComputeMaxStack(InstructionEncoder il)
    {
        byte[] code = il.CodeBuilder.ToArray();
        return ComputeMaxStack(code);
    }

    /// <summary>
    /// Computes a valid <c>.maxstack</c> upper bound for the raw IL byte
    /// stream <paramref name="code"/>.
    /// </summary>
    /// <param name="code">The serialized IL instruction stream.</param>
    /// <returns>The maximum evaluation-stack depth to declare.</returns>
    public static int ComputeMaxStack(byte[] code)
    {
        if (code == null || code.Length == 0)
        {
            return 0;
        }

        long pushes = 0;
        int pos = 0;
        while (pos < code.Length)
        {
            short key;
            byte b0 = code[pos];
            if (b0 == 0xFE && pos + 1 < code.Length)
            {
                key = unchecked((short)(0xFE00 | code[pos + 1]));
                pos += 2;
            }
            else
            {
                key = b0;
                pos += 1;
            }

            if (!Table.TryGetValue(key, out var info))
            {
                // Unknown/unsupported opcode: fall back to the structural
                // upper bound (treat as a single push and a single operand
                // byte). This can only over-estimate, never under-estimate.
                pushes += 1;
                pos += 1;
                continue;
            }

            pushes += info.Push;

            if (info.IsSwitch)
            {
                if (pos + 4 > code.Length)
                {
                    break;
                }

                uint count = BitConverter.ToUInt32(code, pos);
                pos += 4 + checked((int)(count * 4));
            }
            else
            {
                pos += info.OperandSize;
            }
        }

        if (pushes > ushort.MaxValue)
        {
            return ushort.MaxValue;
        }

        return (int)pushes;
    }

    private static Dictionary<short, OpCodeInfo> BuildTable()
    {
        var table = new Dictionary<short, OpCodeInfo>();
        foreach (var field in typeof(OpCodes).GetFields())
        {
            if (field.GetValue(null) is not OpCode op)
            {
                continue;
            }

            short key = op.Value;
            if (op.Size == 2)
            {
                key = unchecked((short)(0xFE00 | (op.Value & 0xFF)));
            }

            table[key] = new OpCodeInfo(
                OperandSize(op.OperandType),
                PushCount(op.StackBehaviourPush),
                op.OperandType == OperandType.InlineSwitch);
        }

        return table;
    }

    private static int OperandSize(OperandType operandType) => operandType switch
    {
        OperandType.InlineNone => 0,
        OperandType.ShortInlineBrTarget => 1,
        OperandType.ShortInlineI => 1,
        OperandType.ShortInlineVar => 1,
        OperandType.InlineVar => 2,
        OperandType.InlineBrTarget => 4,
        OperandType.InlineField => 4,
        OperandType.InlineI => 4,
        OperandType.InlineMethod => 4,
        OperandType.InlineSig => 4,
        OperandType.InlineString => 4,
        OperandType.InlineTok => 4,
        OperandType.InlineType => 4,
        OperandType.ShortInlineR => 4,
        OperandType.InlineSwitch => 4,
        OperandType.InlineI8 => 8,
        OperandType.InlineR => 8,
#pragma warning disable CS0618 // InlinePhi is obsolete but kept for completeness.
        OperandType.InlinePhi => 0,
#pragma warning restore CS0618
        _ => 4,
    };

    private static int PushCount(StackBehaviour push) => push switch
    {
        StackBehaviour.Push0 => 0,
        StackBehaviour.Push1 => 1,
        StackBehaviour.Pushi => 1,
        StackBehaviour.Pushi8 => 1,
        StackBehaviour.Pushr4 => 1,
        StackBehaviour.Pushr8 => 1,
        StackBehaviour.Pushref => 1,
        StackBehaviour.Push1_push1 => 2,

        // Varpush: call/callvirt/newobj/calli push at most one value.
        StackBehaviour.Varpush => 1,
        _ => 1,
    };

    private readonly struct OpCodeInfo
    {
        public OpCodeInfo(int operandSize, int push, bool isSwitch)
        {
            this.OperandSize = operandSize;
            this.Push = push;
            this.IsSwitch = isSwitch;
        }

        public int OperandSize { get; }

        public int Push { get; }

        public bool IsSwitch { get; }
    }
}
