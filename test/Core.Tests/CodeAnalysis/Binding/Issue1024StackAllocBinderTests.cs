// <copyright file="Issue1024StackAllocBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1024 / ADR-0124: binder coverage for the <c>stackalloc T[n]</c>
/// stack-allocation expression. The default (safe) form yields a
/// <c>System.Span&lt;T&gt;</c> and needs no <c>unsafe</c> context; the
/// pointer form (<c>var p *T = stackalloc T[n]</c>) yields the raw <c>T*</c>
/// inside an unsafe context. The element type must be blittable/unmanaged.
/// </summary>
public class Issue1024StackAllocBinderTests
{
    [Fact]
    public void SafeSpanForm_Binds_NoGS0125()
    {
        // The original issue repro previously failed with GS0125
        // ("Variable 'stackalloc' doesn't exist.") because `stackalloc` was
        // parsed as an identifier reference rather than an expression.
        const string source = @"
package p
func F() { var buf = stackalloc uint8[4] }
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SafeSpanForm_ResultIsSpan()
    {
        const string source = @"
package p
import System
func F() {
    var buf = stackalloc int32[3]
    Console.WriteLine(buf.Length)
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SafeSpanForm_NoUnsafeContextRequired()
    {
        const string source = @"
package p
func F() {
    var buf = stackalloc uint8[8]
    buf[0] = uint8(1)
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NonBlittableElementType_ReportsGS0399()
    {
        const string source = @"
package p
func F() { var buf = stackalloc string[4] }
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0399");
    }

    [Fact]
    public void UndefinedElementType_ReportsGS0113()
    {
        const string source = @"
package p
func F() { var buf = stackalloc Nope[4] }
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0113");
    }

    [Fact]
    public void PointerForm_InsideUnsafe_Binds()
    {
        const string source = @"
package p
import System
unsafe func run() {
    var p *int32 = stackalloc int32[3]
    p[0] = 1
    Console.WriteLine(p[0])
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void RuntimeLengthCount_Binds()
    {
        const string source = @"
package p
func F(n int32) {
    var buf = stackalloc uint8[n]
    buf[0] = uint8(0)
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void StackAllocIsContextualKeyword_PlainIdentifierStillWorks()
    {
        // `stackalloc` is only a keyword in the exact `stackalloc IDENT [`
        // shape; any other position keeps lexing it as a plain identifier.
        const string source = @"
package p
import System
func F() {
    var stackalloc = 5
    Console.WriteLine(stackalloc + 1)
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
