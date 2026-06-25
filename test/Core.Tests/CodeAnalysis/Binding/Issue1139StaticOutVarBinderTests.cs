// <copyright file="Issue1139StaticOutVarBinderTests.cs" company="GSharp">
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
/// Issue #1139 / ADR-0060 (follow-up to #1133): an inline <c>out var n</c>
/// (and <c>out let n</c> / <c>out _</c>) declaration at a <em>qualified static</em>
/// call site (<c>C.G(out var n)</c>) was bound with <c>TypeSymbol.Error</c> on the
/// first pass — before the static overload was resolved — and never declared the
/// local in the enclosing block scope, so a subsequent read of <c>n</c> failed with
/// <c>GS0125</c>. #1137 fixed the user-instance path
/// (<c>BindUserInstanceCall</c>); this covers the qualified-static path
/// (<c>BindUserTypeStaticCall</c>). Tests cover <c>out var</c>, the read-only
/// (<c>out let</c>) and discard (<c>out _</c>) forms, and a generic
/// out-parameter where the local must bind as the substituted pointee type.
/// </summary>
public class Issue1139StaticOutVarBinderTests
{
    [Fact]
    public void QualifiedStatic_OutVar_DeclaresLocalInEnclosingScope_NoGS0125()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) bool {
            x = 13
            return true
        }
    }
    func F() int32 {
        if C.G(out var y) {
            return y
        }
        return 0
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStatic_OutVar_SimpleStatement_NoDiagnostics()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
    }
    func F() int32 {
        C.G(out var y)
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStatic_OutLet_DeclaresReadOnlyLocal_ReadIsFine()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
    }
    func F() int32 {
        C.G(out let y)
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStatic_OutLet_AssigningAfterwards_ReportsReadOnly()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
    }
    func F() int32 {
        C.G(out let y)
        y = 9
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void QualifiedStatic_OutDiscard_DoesNotLeakName()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
    }
    func F() int32 {
        C.G(out _)
        return _
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void QualifiedStatic_OutDiscard_AloneCompiles()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
    }
    func F() int32 {
        C.G(out _)
        return 1
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStatic_GenericOutParameter_OutVar_BindsSubstitutedType_NoDiagnostics()
    {
        // The out-var local must bind as the substituted parameter pointee
        // type (int32 here), not the open type parameter `T`.
        const string source = @"
package p
class C {
    shared {
        func M[T](seed T, out result T) { result = seed }
    }
    func F() int32 {
        C.M[int32](7, out var y)
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStatic_Control_PreDeclaredOutLocal_StillCompiles()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
    }
    func F() int32 {
        var y int32
        C.G(out y)
        return y
    }
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
