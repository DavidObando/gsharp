// <copyright file="Issue2175PointerCompoundAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2175 / ADR-0122 §5: inside an <c>unsafe</c> context the binary
/// pointer arithmetic forms <c>p + i</c> / <c>p - i</c> bind and lower to
/// scaled native-int arithmetic, but the compound-assignment forms
/// <c>p += i</c> / <c>p -= i</c> were rejected with GS0129 even though
/// <c>p += i</c> is exactly <c>p = p + i</c>. The fix makes the compound
/// binder reuse the SAME pointer binary-operator lowering when the target is
/// an unmanaged pointer (<c>*T</c>), generalizing across every legal pointee
/// type, both <c>+=</c> and <c>-=</c>, and any integer RHS the binary path
/// accepts.
/// </summary>
public class Issue2175PointerCompoundAssignmentEmitTests
{
    [Fact]
    public void PointerCompoundAssignment_UInt8_Binds()
    {
        // The exact repro from issue #2175: `ArithBinary` already compiled;
        // `ArithCompound` used to error GS0129 on both `+=` and `-=`.
        const string Source = @"
package R
unsafe class P {
    unsafe func ArithBinary(pBuf *uint8, n int32) *uint8 {
        var q = pBuf + n
        return q
    }
    unsafe func ArithCompound(pBuf *uint8, n int32) *uint8 {
        var q = pBuf
        q += n
        q -= n
        return q
    }
}
";
        var diagnostics = GetDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void PointerCompoundAssignment_Int32Pointee_Binds()
    {
        // Generalizes beyond `*uint8`: a `*int32` pointee scales by 4.
        const string Source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2, 3, 4}
    var p *int32 = &arr[0]
    var q = p
    q += 2
    q -= 1
}
";
        var diagnostics = GetDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void PointerCompoundAssignment_VoidPointee_ReportsGS0403()
    {
        // A `*void` pointer has no element size, so compound arithmetic must be
        // rejected exactly as the binary `p + i` form rejects it (ADR-0122 §3).
        const string Source = @"
package P
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p *int32 = &arr[0]
    var v = *void(p)
    v += 1
}
";
        var diagnostics = GetDiagnostics(Source);
        Assert.Contains(diagnostics, d => d.Id == "GS0403");
    }

    [Fact]
    public void PointerCompoundAssignment_PlusEquals_Int32_AdvancesScaledByElementSize()
    {
        // `q += 2` on a `*int32` must advance by 2 elements (8 bytes), landing
        // on arr[2], identical to `q = q + 2`.
        const string Source = @"package Issue2175PlusEq
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    var q = p
    q += 2
    Console.WriteLine(*q)
    q -= 1
    Console.WriteLine(*q)
}

run()
";
        var output = CompileAndRun(Source, "Issue2175PlusEq");
        var lines = output.Split(new[] { Environment.NewLine, "\n" }, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("7", lines[0]);
        Assert.Equal("5", lines[1]);
    }

    [Fact]
    public void PointerCompoundAssignment_UInt8_AdvancesByOneByteElement()
    {
        // A `*uint8` pointee scales by 1: `q += 3` lands on arr[3].
        const string Source = @"package Issue2175UInt8
import System

unsafe func run() {
    var arr = []uint8{10, 20, 30, 40}
    var p *uint8 = &arr[0]
    var q = p
    q += 3
    Console.WriteLine(*q)
    q -= 2
    Console.WriteLine(*q)
}

run()
";
        var output = CompileAndRun(Source, "Issue2175UInt8");
        var lines = output.Split(new[] { Environment.NewLine, "\n" }, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("40", lines[0]);
        Assert.Equal("20", lines[1]);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
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

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
