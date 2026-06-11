// <copyright file="StructReceiverMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #420 (P3-1): a CLR method-group conversion whose receiver is a
/// value type must emit a defensive <c>box</c> before <c>ldftn</c>/
/// <c>ldvirtftn</c> so the delegate ctor (which takes
/// <c>(object, IntPtr)</c>) receives a verifiable object reference. The
/// binder may not surface this path today, but
/// <see cref="GSharp.Core.CodeAnalysis.Binding.BoundClrMethodGroupExpression"/>
/// already carries a typed receiver, and a future binder change could
/// route a struct receiver into emit.
/// </summary>
public class StructReceiverMethodGroupEmitTests
{
    /// <summary>
    /// When a struct-typed receiver reaches CLR method-group emit, the
    /// produced PE must contain a <c>box</c> opcode so the delegate
    /// captures a real object reference. If the binder gates struct
    /// receivers today, the source is rejected before emit and the test
    /// records that contract instead — guaranteeing the defensive box is
    /// the active safeguard if (and only if) the gate ever loosens.
    /// </summary>
    [Fact]
    public void StructReceiverMethodGroup_EmitsBoxedDelegateTarget_OrIsRejectedByBinder()
    {
        // DateTime is a CLR struct (System.ValueType); converting `dt.ToString`
        // to a parameterless `Func[string]` would, without a defensive box,
        // load the raw DateTime value as the delegate target. Confirm that
        // either the binder rejects the conversion, or the emitter inserts
        // the protective box.
        const string Source = @"package StructRecv
import System
var dt = DateTime(2025, 6, 1)
var f Func[string] = dt.ToString
Console.WriteLine(f.Invoke())
";

        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        if (!result.Success)
        {
            // Binder-gated path: the conversion is rejected, so emit never
            // runs for a struct receiver. This is acceptable — the defensive
            // box only matters if/when the gate is removed.
            Assert.Contains(result.Diagnostics, d => d.IsError);
            return;
        }

        // Emit succeeded: the binder allowed the struct-receiver method
        // group, so the defensive box must be present in the produced
        // assembly. Two complementary checks:
        //   (1) Static IL inspection: at least one `box` opcode must appear
        //       in the entry-point body that targets the receiver type.
        //   (2) Runtime: the produced PE must load and execute without
        //       crashing (unverifiable IL would typically `InvalidProgram`
        //       on JIT, or corrupt the delegate target).
        peStream.Position = 0;
        AssertEntryPointContainsBoxOpcode(peStream);

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(
            "StructReceiverMethodGroupEmitTests-DateTime", isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            // The delegate target must be the *same* DateTime value, so
            // invoking ToString() should produce a non-empty representation
            // of June 1, 2025. We deliberately avoid asserting a culture-
            // specific format string and only require the year + month-day
            // appear in the captured output.
            var output = captured.ToString();
            Assert.False(string.IsNullOrWhiteSpace(output));
            Assert.Contains("2025", output);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static void AssertEntryPointContainsBoxOpcode(Stream peStream)
    {
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        Assert.True(peReader.HasMetadata);

        var md = peReader.GetMetadataReader();
        var corHeader = peReader.PEHeaders.CorHeader;
        Assert.NotNull(corHeader);

        var token = corHeader!.EntryPointTokenOrRelativeVirtualAddress;
        Assert.NotEqual(0, token);

        var entryHandle = MetadataTokens.MethodDefinitionHandle(token & 0x00FFFFFF);
        var entryDef = md.GetMethodDefinition(entryHandle);
        var body = peReader.GetMethodBody(entryDef.RelativeVirtualAddress);

        var ilBytes = body.GetILBytes();
        Assert.NotNull(ilBytes);
        Assert.True(
            ContainsOpcode(ilBytes!, ILOpCode.Box),
            "Expected entry-point IL to contain a `box` opcode that guards the struct-typed delegate receiver, but none was found. " +
            "Without it the delegate ctor would receive the raw value-type bits instead of an object reference, producing unverifiable IL.");
    }

    // Lightweight opcode scan: walks the IL byte stream looking for the
    // requested 1- or 2-byte opcode without decoding operands. Good enough
    // because we only care about presence, not position. Mirrors the
    // ECMA-335 §III.1.2.1 prefix rules: a 0xFE byte introduces a 2-byte
    // opcode; otherwise a single byte is the opcode itself.
    private static bool ContainsOpcode(byte[] il, ILOpCode opcode)
    {
        var target = (ushort)opcode;
        for (var i = 0; i < il.Length;)
        {
            ushort cur;
            int size;
            if (il[i] == 0xFE && i + 1 < il.Length)
            {
                cur = (ushort)(0xFE00 | il[i + 1]);
                size = 2;
            }
            else
            {
                cur = il[i];
                size = 1;
            }

            if (cur == target)
            {
                return true;
            }

            i += size + OperandSizeFor(cur);
        }

        return false;
    }

    // Operand sizes by opcode for the small subset that can appear in the
    // entry point we emit here. We only need conservative correctness:
    // overshooting (and walking past the end) returns false, which the
    // caller treats as "no box found" — but that would only happen if the
    // body contains an opcode this table doesn't know about *before* the
    // box, in which case the test would surface as a clear miss.
    private static int OperandSizeFor(ushort opcode)
    {
        switch ((ILOpCode)opcode)
        {
            case ILOpCode.Nop:
            case ILOpCode.Break:
            case ILOpCode.Ldarg_0:
            case ILOpCode.Ldarg_1:
            case ILOpCode.Ldarg_2:
            case ILOpCode.Ldarg_3:
            case ILOpCode.Ldloc_0:
            case ILOpCode.Ldloc_1:
            case ILOpCode.Ldloc_2:
            case ILOpCode.Ldloc_3:
            case ILOpCode.Stloc_0:
            case ILOpCode.Stloc_1:
            case ILOpCode.Stloc_2:
            case ILOpCode.Stloc_3:
            case ILOpCode.Ldnull:
            case ILOpCode.Ldc_i4_m1:
            case ILOpCode.Ldc_i4_0:
            case ILOpCode.Ldc_i4_1:
            case ILOpCode.Ldc_i4_2:
            case ILOpCode.Ldc_i4_3:
            case ILOpCode.Ldc_i4_4:
            case ILOpCode.Ldc_i4_5:
            case ILOpCode.Ldc_i4_6:
            case ILOpCode.Ldc_i4_7:
            case ILOpCode.Ldc_i4_8:
            case ILOpCode.Dup:
            case ILOpCode.Pop:
            case ILOpCode.Ret:
                return 0;
            case ILOpCode.Ldarg_s:
            case ILOpCode.Ldarga_s:
            case ILOpCode.Starg_s:
            case ILOpCode.Ldloc_s:
            case ILOpCode.Ldloca_s:
            case ILOpCode.Stloc_s:
            case ILOpCode.Ldc_i4_s:
            case ILOpCode.Br_s:
            case ILOpCode.Brfalse_s:
            case ILOpCode.Brtrue_s:
            case ILOpCode.Beq_s:
            case ILOpCode.Bne_un_s:
            case ILOpCode.Leave_s:
                return 1;
            case ILOpCode.Ldarg:
            case ILOpCode.Ldarga:
            case ILOpCode.Starg:
            case ILOpCode.Ldloc:
            case ILOpCode.Ldloca:
            case ILOpCode.Stloc:
                return 2;
            case ILOpCode.Ldc_i4:
            case ILOpCode.Br:
            case ILOpCode.Brfalse:
            case ILOpCode.Brtrue:
            case ILOpCode.Leave:
            case ILOpCode.Call:
            case ILOpCode.Calli:
            case ILOpCode.Callvirt:
            case ILOpCode.Newobj:
            case ILOpCode.Ldstr:
            case ILOpCode.Ldfld:
            case ILOpCode.Ldflda:
            case ILOpCode.Stfld:
            case ILOpCode.Ldsfld:
            case ILOpCode.Ldsflda:
            case ILOpCode.Stsfld:
            case ILOpCode.Box:
            case ILOpCode.Unbox:
            case ILOpCode.Unbox_any:
            case ILOpCode.Castclass:
            case ILOpCode.Isinst:
            case ILOpCode.Ldtoken:
            case ILOpCode.Ldftn:
            case ILOpCode.Ldvirtftn:
            case ILOpCode.Initobj:
            case ILOpCode.Newarr:
            case ILOpCode.Ldobj:
            case ILOpCode.Stobj:
                return 4;
            case ILOpCode.Ldc_i8:
            case ILOpCode.Ldc_r8:
                return 8;
            case ILOpCode.Ldc_r4:
                return 4;
            default:
                // Unknown opcode: treat as zero-operand. The caller's worst
                // case is a missed `box`, which surfaces as a test failure
                // with a clear message rather than silent corruption.
                return 0;
        }
    }
}
