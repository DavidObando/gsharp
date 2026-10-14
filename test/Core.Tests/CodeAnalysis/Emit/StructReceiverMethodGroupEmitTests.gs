// <copyright file="StructReceiverMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Issue #420 (P3-1): a CLR method-group conversion whose receiver is a
/// value type must emit a defensive `box` before `ldftn`/
/// `ldvirtftn` so the delegate ctor (which takes
/// `(object, IntPtr)`) receives a verifiable object reference. The
/// binder may not surface this path today, but
/// (cref:GSharp.Core.CodeAnalysis.Binding.BoundClrMethodGroupExpression)
/// already carries a typed receiver, and a future binder change could
/// route a struct receiver into emit.
open class StructReceiverMethodGroupEmitTests {
    /// When a struct-typed receiver reaches CLR method-group emit, the
    /// produced PE must contain a `box` opcode so the delegate
    /// captures a real object reference. If the binder gates struct
    /// receivers today, the source is rejected before emit and the test
    /// records that contract instead — guaranteeing the defensive box is
    /// the active safeguard if (and only if) the gate ever loosens.
    @Fact
    func StructReceiverMethodGroup_EmitsBoxedDelegateTarget_OrIsRejectedByBinder() {
        // DateTime is a CLR struct (System.ValueType); converting `dt.ToString`
        // to a parameterless `Func[string]` would, without a defensive box,
        // load the raw DateTime value as the delegate target. Confirm that
        // either the binder rejects the conversion, or the emitter inserts
        // the protective box.
        const Source = `package StructRecv
import System
var dt = DateTime(2025, 6, 1)
var f Func[string] = dt.ToString
Console.WriteLine(f.Invoke())
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(peStream)
        if !result.Success {
            // Binder-gated path: the conversion is rejected, so emit never
            // runs for a struct receiver. This is acceptable — the defensive
            // box only matters if/when the gate is removed.
            Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
            return
        }
        // Emit succeeded: the binder allowed the struct-receiver method
        // group, so the defensive box must be present in the produced
        // assembly. Two complementary checks:
        //   (1) Static IL inspection: at least one `box` opcode must appear
        //       in the entry-point body that targets the receiver type.
        //   (2) Runtime: the produced PE must load and execute without
        //       crashing (unverifiable IL would typically `InvalidProgram`
        //       on JIT, or corrupt the delegate target).
        peStream.Position = 0
        AssertEntryPointContainsBoxOpcode(peStream)
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("StructReceiverMethodGroupEmitTests-DateTime", isCollectible: true)
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let entry MethodInfo? = programType!!.GetMethod(
                "<Main>$$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(entry)
            let stdout = Console.Out
            let captured = StringWriter()
            Console.SetOut(captured)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(stdout)
            }
            // The delegate target must be the *same* DateTime value, so
            // invoking ToString() should produce a non-empty representation
            // of June 1, 2025. We deliberately avoid asserting a culture-
            // specific format string and only require the year + month-day
            // appear in the captured output.
            let output = captured.ToString()
            Assert.False(string.IsNullOrWhiteSpace(output))
            Assert.Contains("2025", output)
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func AssertEntryPointContainsBoxOpcode(peStream Stream) {
            using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
            Assert.True(peReader.HasMetadata)
            let md = peReader.GetMetadataReader()
            let corHeader CorHeader? = peReader.PEHeaders.CorHeader
            Assert.NotNull(corHeader)
            let token = corHeader!!.EntryPointTokenOrRelativeVirtualAddress
            Assert.NotEqual(0, token)
            let entryHandle = MetadataTokens.MethodDefinitionHandle(token & 0x00FFFFFF)
            let entryDef = md.GetMethodDefinition(entryHandle)
            let body = peReader.GetMethodBody(entryDef.RelativeVirtualAddress)
            let ilBytes[]?uint8 = body.GetILBytes()
            Assert.NotNull(ilBytes)
            Assert.True(
                ContainsOpcode(ilBytes!!, ILOpCode.Box),
                "Expected entry-point IL to contain a `box` opcode that guards the struct-typed delegate receiver, but none was found. " +
                    "Without it the delegate ctor would receive the raw value-type bits instead of an object reference, producing unverifiable IL."
            )
        }

        // Lightweight opcode scan: walks the IL byte stream looking for the
        // requested 1- or 2-byte opcode without decoding operands. Good enough
        // because we only care about presence, not position. Mirrors the
        // ECMA-335 §III.1.2.1 prefix rules: a 0xFE byte introduces a 2-byte
        // opcode; otherwise a single byte is the opcode itself.
        private func ContainsOpcode(il[]?uint8, opcode ILOpCode) bool {
            let target = uint16(opcode)
            for var i = 0; i < il!!.Length; {
                var cur uint16
                var size int32
                if il!![i] == uint8(0xFE) && i + 1 < il!!.Length {
                    cur = uint16((0xFE00 | int32(il!![i + 1])))
                    size = 2
                } else {
                    cur = il!![i]
                    size = 1
                }
                if cur == target {
                    return true
                }
                i += size + OperandSizeFor(cur)
            }
            return false
        }

        // Operand sizes by opcode for the small subset that can appear in the
        // entry point we emit here. We only need conservative correctness:
        // overshooting (and walking past the end) returns false, which the
        // caller treats as "no box found" — but that would only happen if the
        // body contains an opcode this table doesn't know about *before* the
        // box, in which case the test would surface as a clear miss.
        private func OperandSizeFor(opcode uint16) int32 {
            switch ILOpCode(opcode) {
                case ILOpCode.Nop,
                ILOpCode.Break,
                ILOpCode.Ldarg_0,
                ILOpCode.Ldarg_1,
                ILOpCode.Ldarg_2,
                ILOpCode.Ldarg_3,
                ILOpCode.Ldloc_0,
                ILOpCode.Ldloc_1,
                ILOpCode.Ldloc_2,
                ILOpCode.Ldloc_3,
                ILOpCode.Stloc_0,
                ILOpCode.Stloc_1,
                ILOpCode.Stloc_2,
                ILOpCode.Stloc_3,
                ILOpCode.Ldnull,
                ILOpCode.Ldc_i4_m1,
                ILOpCode.Ldc_i4_0,
                ILOpCode.Ldc_i4_1,
                ILOpCode.Ldc_i4_2,
                ILOpCode.Ldc_i4_3,
                ILOpCode.Ldc_i4_4,
                ILOpCode.Ldc_i4_5,
                ILOpCode.Ldc_i4_6,
                ILOpCode.Ldc_i4_7,
                ILOpCode.Ldc_i4_8,
                ILOpCode.Dup,
                ILOpCode.Pop,
                ILOpCode.Ret {
                    return 0
                }
                case ILOpCode.Ldarg_s,
                ILOpCode.Ldarga_s,
                ILOpCode.Starg_s,
                ILOpCode.Ldloc_s,
                ILOpCode.Ldloca_s,
                ILOpCode.Stloc_s,
                ILOpCode.Ldc_i4_s,
                ILOpCode.Br_s,
                ILOpCode.Brfalse_s,
                ILOpCode.Brtrue_s,
                ILOpCode.Beq_s,
                ILOpCode.Bne_un_s,
                ILOpCode.Leave_s {
                    return 1
                }
                case ILOpCode.Ldarg, ILOpCode.Ldarga, ILOpCode.Starg, ILOpCode.Ldloc, ILOpCode.Ldloca, ILOpCode.Stloc {
                    return 2
                }
                case ILOpCode.Ldc_i4,
                ILOpCode.Br,
                ILOpCode.Brfalse,
                ILOpCode.Brtrue,
                ILOpCode.Leave,
                ILOpCode.Call,
                ILOpCode.Calli,
                ILOpCode.Callvirt,
                ILOpCode.Newobj,
                ILOpCode.Ldstr,
                ILOpCode.Ldfld,
                ILOpCode.Ldflda,
                ILOpCode.Stfld,
                ILOpCode.Ldsfld,
                ILOpCode.Ldsflda,
                ILOpCode.Stsfld,
                ILOpCode.Box,
                ILOpCode.Unbox,
                ILOpCode.Unbox_any,
                ILOpCode.Castclass,
                ILOpCode.Isinst,
                ILOpCode.Ldtoken,
                ILOpCode.Ldftn,
                ILOpCode.Ldvirtftn,
                ILOpCode.Initobj,
                ILOpCode.Newarr,
                ILOpCode.Ldobj,
                ILOpCode.Stobj {
                    return 4
                }
                case ILOpCode.Ldc_i8, ILOpCode.Ldc_r8 {
                    return 8
                }
                case ILOpCode.Ldc_r4 {
                    return 4
                }
                default {
                    // Unknown opcode: treat as zero-operand. The caller's worst
                    // case is a missed `box`, which surfaces as a test failure
                    // with a clear message rather than silent corruption.
                    return 0
                }
            }
        }
    }
}
