// <copyright file="MaxStackTracker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// Computes the `.maxstack` value (maximum evaluation-stack depth) for an
/// emitted method body so that
/// (cref:System.Reflection.Metadata.Ecma335.MethodBodyStreamEncoder.AddMethodBody(InstructionEncoder,
/// int, StandaloneSignatureHandle, MethodBodyAttributes, bool))
/// no longer falls back to the format default of `8` (issue #1490).
/// @remarks The naïve default of 8 produces <em>invalid IL</em> for any body whose
/// evaluation-stack peak exceeds eight slots (a call/constructor with many
/// arguments, a deeply nested arithmetic expression, an async
/// `MoveNext` state machine, …). `ilverify` rejects such bodies
/// with `StackOverflow` because the computed depth exceeds the declared
/// `.maxstack`.
///
/// A <em>precise</em> peak cannot be recovered from the emitted IL bytes
/// alone: `call`/`callvirt`/`newobj`/`calli` are
/// `varpop` — their pop count depends on the callee signature, which is
/// not encoded in the opcode stream. gsc emits these instructions from ~40
/// scattered sites (some via `il.Call(handle)`, some via
/// `il.OpCode(Callvirt)+il.Token(handle)`), so threading the per-call
/// argument count through every site would be invasive and error-prone.
///
/// Instead this helper computes a <strong>provably-correct upper bound</strong>
/// on the peak that is independent of control flow and of the
/// (unknown) call pop counts: the sum, over every emitted instruction, of the
/// number of values that instruction <em>pushes</em>. Because every IL
/// instruction has a net stack delta of at most `+1` (even `dup`,
/// which pops one and pushes two), and verifiable IL has a single, path-
/// independent stack height at each offset, the height at any reachable
/// offset equals the sum of net deltas along a simple (acyclic) path to it,
/// which never exceeds the total number of pushes in the body. The bound is
/// therefore guaranteed to be ≥ the true peak and is never an
/// under-estimate, so the emitted `.maxstack` is always valid.
/// `varpop` call instructions are counted as pushing one value (their
/// maximum), which keeps the bound conservative without needing the callee
/// argument count.
internal shared class MaxStackTracker {
    private struct OpCodeInfo {
        init(operandSize int32, push int32, isSwitch bool) {
            this.OperandSize = operandSize
            this.Push = push
            this.IsSwitch = isSwitch
        }

        prop OperandSize int32 {
            get;
        }

        prop Push int32 {
            get;
        }

        prop IsSwitch bool {
            get;
        }
    }

    // Per-opcode decode table: operand byte size (excluding the opcode itself)
    // and the number of values the opcode pushes onto the evaluation stack.
    // Keyed by the encoded opcode value (single-byte opcodes 0x00..0xFF; two-
    // byte 0xFE-prefixed opcodes keyed as unchecked((short)(0xFE00 | second))).
    private let Table Dictionary[int16, OpCodeInfo] = BuildTable()

    /// Computes a valid `.maxstack` upper bound for the body currently
    /// accumulated in [`il`](paramref).
    /// @param il The instruction encoder holding the emitted IL.
    /// @returns The maximum evaluation-stack depth to declare, clamped to the
    /// (cref:ushort) range permitted by the metadata format.
    func ComputeMaxStack(il InstructionEncoder) int32 {
        let code = il.CodeBuilder.ToArray()
        return ComputeMaxStack(code)
    }

    /// Computes a valid `.maxstack` upper bound for the raw IL byte
    /// stream [`code`](paramref).
    /// @param code The serialized IL instruction stream.
    /// @returns The maximum evaluation-stack depth to declare.
    func ComputeMaxStack(code[]?uint8) int32 {
        if code == nil || code.Length == 0 {
            return 0
        }
        var pushes int64 = 0
        var pos = 0
        while pos < code.Length {
            var key int16
            let b0 = code[pos]
            if b0 == uint8(0xFE) && pos + 1 < code.Length {
                let encodedKey = 0xFE00 | int32(code[pos + 1])
                key = unchecked(int16(encodedKey))
                pos += 2
            } else {
                key = b0
                pos += 1
            }
            if !Table.TryGetValue(key, out var info) {
                // Unknown/unsupported opcode: fall back to the structural
                // upper bound (treat as a single push and a single operand
                // byte). This can only over-estimate, never under-estimate.
                pushes += int64(1)
                pos += 1
                continue
            }
            pushes += int64(info.Push)
            if info.IsSwitch {
                if pos + 4 > code.Length {
                    break
                }
                let count = BitConverter.ToUInt32(code, pos)
                pos += 4 + checked(int32((count * uint32(4))))
            } else {
                pos += info.OperandSize
            }
        }
        if pushes > int64(uint16.MaxValue) {
            return uint16.MaxValue
        }
        return int32(pushes)
    }

    private func BuildTable() Dictionary[int16, OpCodeInfo] {
        let table = Dictionary[int16, OpCodeInfo]()
        for field in typeof(OpCodes).GetFields() {
            if field.GetValue(nil) is not OpCode op {
                continue
            }
            var key = op.Value
            if op.Size == 2 {
                key = unchecked(int16((0xFE00 | (int32(op.Value) & 0xFF))))
            }
            table[key] = OpCodeInfo(
                OperandSize(op.OperandType),
                PushCount(op.StackBehaviourPush),
                op.OperandType == OperandType.InlineSwitch
            )
        }
        return table
    }

    private func OperandSize(operandType OperandType) int32 -> switch operandType {
        case OperandType.InlineNone: 0
        case OperandType.ShortInlineBrTarget: 1
        case OperandType.ShortInlineI: 1
        case OperandType.ShortInlineVar: 1
        case OperandType.InlineVar: 2
        case OperandType.InlineBrTarget: 4
        case OperandType.InlineField: 4
        case OperandType.InlineI: 4
        case OperandType.InlineMethod: 4
        case OperandType.InlineSig: 4
        case OperandType.InlineString: 4
        case OperandType.InlineTok: 4
        case OperandType.InlineType: 4
        case OperandType.ShortInlineR: 4
        case OperandType.InlineSwitch: 4
        case OperandType.InlineI8: 8
        case OperandType.InlineR: 8
        case OperandType.InlinePhi: 0
        default: 4
    }

    private func PushCount(push StackBehaviour) int32 -> switch push {
        case StackBehaviour.Push0: 0
        case StackBehaviour.Push1: 1
        case StackBehaviour.Pushi: 1
        case StackBehaviour.Pushi8: 1
        case StackBehaviour.Pushr4: 1
        case StackBehaviour.Pushr8: 1
        case StackBehaviour.Pushref: 1
        case StackBehaviour.Push1_push1: 2
        case StackBehaviour.Varpush: 1
        default: 1
    }
}
