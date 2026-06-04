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
/// <c>Nullable&lt;T&gt;</c> over a value type). This file pins down two
/// behaviours:
/// <list type="bullet">
///   <item>Reference-type operands continue to short-circuit correctly via the
///   existing <c>dup; brtrue</c> pattern.</item>
///   <item>Value-type left operands are rejected loudly at emit time
///   (<see cref="NotSupportedException"/>) so the emitter never produces
///   PEVerify-rejected IL even if the binder/encoder accept the expression.</item>
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
    public void NullCoalesce_ValueType_LeftNullableInt_RejectedByEmitter()
    {
        // `int? ?: 0` would compile the left to a `Nullable<int>` stack value
        // (P2-7's wrapping). `dup; brtrue` on a struct is invalid IL, so the
        // P3-5 guard must reject this at emit time rather than silently
        // producing bad metadata.
        const string Source = @"package NullCoalesceValueTypeGuard
import System
var n int32? = nil
var r int32 = n ?: 0
Console.WriteLine(r)
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();

        // The guard fires twice. In Debug builds `Debug.Assert(false, ...)`
        // raises a DebugAssertException, which escapes `Compilation.Emit`
        // because the `catch when (ex is NotSupportedException || ...)` filter
        // does not match it. In Release builds the assert is a no-op, so the
        // subsequent `throw new NotSupportedException(...)` is caught by that
        // filter and surfaced as a GS9998 emit diagnostic on the returned
        // EmitResult. Accept either shape, and in both cases verify the
        // diagnostic explains the value-type / dup-brtrue issue.
        string message;
        var ex = Record.Exception(() =>
        {
            var result = compilation.Emit(peStream);
            if (!result.Success)
            {
                // Re-throw the emit-time NotSupportedException surfaced as a
                // diagnostic so the test below can assert on its message.
                var diag = result.Diagnostics.FirstOrDefault(d => d.IsError);
                throw new NotSupportedException(diag?.Message ?? "<no diagnostic message>");
            }
        });
        Assert.NotNull(ex);

        var actual = ex!;
        while (actual.InnerException is not null
               && actual is not NotSupportedException
               && actual.GetType().Name != "DebugAssertException")
        {
            actual = actual.InnerException;
        }

        var typeName = actual.GetType().Name;
        Assert.True(
            actual is NotSupportedException || typeName == "DebugAssertException",
            $"expected NotSupportedException or DebugAssertException, got {actual.GetType().FullName}: {actual.Message}");
        message = actual.Message;
        Assert.Contains("Null-coalesce", message, StringComparison.Ordinal);
        Assert.Contains("value-type", message, StringComparison.Ordinal);
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
                entry!.Invoke(null, parameters: null);
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
