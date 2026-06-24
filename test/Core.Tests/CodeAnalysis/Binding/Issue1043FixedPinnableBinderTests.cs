// <copyright file="Issue1043FixedPinnableBinderTests.cs" company="GSharp">
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
/// Issue #1043 / ADR-0125: binder coverage for pinning a span-like source via
/// <c>GetPinnableReference</c> in a <c>fixed</c> statement. A source whose type
/// exposes a public instance <c>ref T GetPinnableReference()</c> (canonically
/// <c>System.Span[T]</c> / <c>System.ReadOnlySpan[T]</c>) now binds without
/// GS0401; a source without such a method (and with a mismatched pointee) is
/// still rejected with GS0401.
/// </summary>
public class Issue1043FixedPinnableBinderTests
{
    [Fact]
    public void SpanSource_InUnsafeContext_Binds()
    {
        const string source = @"
package p
import System
unsafe func F(dest []uint8) {
    var sp Span[uint8] = dest
    fixed pD *uint8 = sp { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ReadOnlySpanSource_InUnsafeContext_Binds()
    {
        const string source = @"
package p
import System
unsafe func F(dest []uint8) {
    var ros ReadOnlySpan[uint8] = dest
    fixed pR *uint8 = ros { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SpanSource_OutsideUnsafeContext_ReportsGS0400()
    {
        const string source = @"
package p
import System
func F(dest []uint8) {
    var sp Span[uint8] = dest
    fixed pD *uint8 = sp { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0400");
    }

    [Fact]
    public void SpanSource_PointeeMismatch_ReportsGS0401()
    {
        const string source = @"
package p
import System
unsafe func F(dest []uint8) {
    var sp Span[uint8] = dest
    fixed p *int32 = sp { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0401");
    }

    [Fact]
    public void NonPinnableSource_WithoutGetPinnableReference_ReportsGS0401()
    {
        // A `List[uint8]` exposes no public instance `ref T GetPinnableReference()`,
        // so it remains an unpinnable source.
        const string source = @"
package p
import System
import System.Collections.Generic
unsafe func F() {
    var lst List[uint8]
    fixed p *uint8 = lst { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0401");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
