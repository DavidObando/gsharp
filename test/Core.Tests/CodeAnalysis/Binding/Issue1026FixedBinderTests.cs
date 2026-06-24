// <copyright file="Issue1026FixedBinderTests.cs" company="GSharp">
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
/// Issue #1026 / ADR-0125: binder coverage for the <c>fixed</c> statement
/// (<c>fixed &lt;name&gt; *T = &lt;source&gt; { ... }</c>), which pins a
/// managed array/slice or string and binds an unmanaged <c>*T</c> pointer to
/// its first element for the duration of the body. The statement is only
/// legal inside an <c>unsafe</c> context (GS0400) and the source must be a
/// pinnable buffer whose element type matches the pointer's pointee (GS0401).
/// </summary>
public class Issue1026FixedBinderTests
{
    [Fact]
    public void SliceSource_InUnsafeContext_Binds()
    {
        const string source = @"
package p
unsafe func F(dest []uint8) {
    fixed pD *uint8 = dest { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void StringSource_InUnsafeContext_Binds()
    {
        const string source = @"
package p
unsafe func F() {
    fixed pC *uint16 = ""ABC"" { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void UnsafeBlock_EstablishesContext_Binds()
    {
        const string source = @"
package p
func F(dest []uint8) {
    unsafe {
        fixed pD *uint8 = dest { }
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void OutsideUnsafeContext_ReportsGS0400()
    {
        const string source = @"
package p
func F(dest []uint8) {
    fixed pD *uint8 = dest { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0400");
    }

    [Fact]
    public void UnpinnableSource_ReportsGS0401()
    {
        const string source = @"
package p
unsafe func F() {
    fixed p *int32 = int32(5) { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0401");
    }

    [Fact]
    public void ElementTypeMismatch_ReportsGS0401()
    {
        const string source = @"
package p
unsafe func F(dest []uint8) {
    fixed p *int32 = dest { }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0401");
    }

    [Fact]
    public void PointerVariableScopedToBody()
    {
        // The bound `*T` pointer is only valid inside the body; referencing it
        // after the block must not resolve.
        const string source = @"
package p
import System
unsafe func F(dest []uint8) {
    fixed pD *uint8 = dest { }
    Console.WriteLine(nint(pD))
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0125");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
