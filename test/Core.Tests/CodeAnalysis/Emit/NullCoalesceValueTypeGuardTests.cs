// <copyright file="NullCoalesceValueTypeGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #420 / P3-5: the null-coalesce (<c>??</c> / <c>?:</c>) emit path uses
/// <c>dup; brtrue</c> which is only legal for object references and primitive
/// integers — it is invalid IL for struct stack values (including
/// <c>Nullable&lt;T&gt;</c> over a value type).
///
/// Issue #519 retired the historical fail-fast guard for value-type
/// <c>Nullable&lt;T&gt;</c> operands by lowering them to a HasValue/get_Value
/// sequence over a pre-allocated scratch slot. This file now pins down both
/// behaviours that survived the change:
/// <list type="bullet">
///   <item>Reference-type operands continue to short-circuit correctly via the
///   existing <c>dup; brtrue</c> pattern.</item>
///   <item>Value-type <c>Nullable&lt;T&gt;</c> operands now compile and run
///   correctly through the HasValue path (and produce verifiable IL — see
///   <c>Issue519CoalesceNullableEmitTests</c> in the Compiler.Tests project for
///   the ilverify-gated end-to-end shape).</item>
/// </list>
/// </summary>
public class NullCoalesceValueTypeGuardTests
{
    [Fact]
    public void NullCoalesce_ReferenceType_LeftNonNil_ReturnsLeft()
    {
        const string Source = @"package NullCoalesceRefNonNil
import System
var s string? = ""hello""
var r string = s ?: ""fallback""
Console.WriteLine(r)
";
        var stdout = CompileLoadInvokeCaptureStdout(Source, nameof(NullCoalesce_ReferenceType_LeftNonNil_ReturnsLeft));
        Assert.Equal("hello", stdout.Trim());
    }

    [Fact]
    public void NullCoalesce_ReferenceType_LeftNil_ReturnsRight()
    {
        const string Source = @"package NullCoalesceRefNil
import System
var s string? = nil
var r string = s ?: ""fallback""
Console.WriteLine(r)
";
        var stdout = CompileLoadInvokeCaptureStdout(Source, nameof(NullCoalesce_ReferenceType_LeftNil_ReturnsRight));
        Assert.Equal("fallback", stdout.Trim());
    }

    [Fact]
    public void NullCoalesce_ValueType_LeftNullableInt_LeftNil_ReturnsRight()
    {
        // Issue #519: `int? ?: 0` previously aborted emit because `dup;
        // brtrue` is invalid IL for the `Nullable<int>` struct on the
        // stack. The emitter now spills the LHS into a pre-allocated
        // `Nullable<int>` slot and branches on `Nullable<T>::get_HasValue`,
        // producing verifiable IL that returns the right operand when the
        // left is absent.
        const string Source = @"package NullCoalesceValueTypeNil
import System
var n int32? = nil
var r int32 = n ?: 99
Console.WriteLine(r)
";
        var stdout = CompileLoadInvokeCaptureStdout(Source, nameof(NullCoalesce_ValueType_LeftNullableInt_LeftNil_ReturnsRight));
        Assert.Equal("99", stdout.Trim());
    }

    [Fact]
    public void NullCoalesce_ValueType_LeftNullableInt_LeftPresent_ReturnsUnderlying()
    {
        // Symmetric case: when the LHS carries a value, the result is the
        // underlying primitive — fetched via `Nullable<T>::get_Value()` off
        // the spilled slot's address (the same path PR #541 added for `!!`).
        const string Source = @"package NullCoalesceValueTypePresent
import System
var n int32? = 7
var r int32 = n ?: 99
Console.WriteLine(r)
";
        var stdout = CompileLoadInvokeCaptureStdout(Source, nameof(NullCoalesce_ValueType_LeftNullableInt_LeftPresent_ReturnsUnderlying));
        Assert.Equal("7", stdout.Trim());
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var originalOut = Console.Out;
            using var sw = new StringWriter();
            Console.SetOut(sw);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(originalOut);
            }

            return sw.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
