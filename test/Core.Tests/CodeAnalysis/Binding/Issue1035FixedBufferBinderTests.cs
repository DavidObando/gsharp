// <copyright file="Issue1035FixedBufferBinderTests.cs" company="GSharp">
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
/// Issue #1035 / ADR-0122 §10: binder coverage for fixed-size buffer fields
/// (<c>fixed name [N]T</c>). A fixed buffer is legal inside an <c>unsafe</c>
/// struct with a blittable primitive element type and a positive constant
/// length; use outside an unsafe context (GS0406), a non-supported element
/// type (GS0409), and a non-positive length (GS0408) are rejected.
/// </summary>
public class Issue1035FixedBufferBinderTests
{
    [Fact]
    public void FixedBuffer_InsideUnsafeStruct_NoError()
    {
        const string source = @"
package P
import System

unsafe struct Buf {
    fixed data [8]int32
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void FixedBuffer_OutsideUnsafe_ReportsGS0406()
    {
        const string source = @"
package P
import System

struct Buf {
    fixed data [8]int32
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0406");
    }

    [Fact]
    public void FixedBuffer_NonBlittableElement_ReportsGS0409()
    {
        const string source = @"
package P
import System

unsafe struct Buf {
    fixed data [4]string
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0409");
    }

    [Fact]
    public void FixedBuffer_IndexThroughPointer_NoError()
    {
        const string source = @"
package P
import System

unsafe struct Buf {
    fixed data [8]int32
}

unsafe func run() {
    var b = Buf{}
    var p = &b
    p->data[0] = 1
    var x = p->data[0]
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
