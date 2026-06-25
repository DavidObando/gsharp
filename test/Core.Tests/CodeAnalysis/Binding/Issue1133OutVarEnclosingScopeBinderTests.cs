// <copyright file="Issue1133OutVarEnclosingScopeBinderTests.cs" company="GSharp">
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
/// Issue #1133 / ADR-0060: an inline <c>out var n</c> (and <c>out let n</c> /
/// <c>out _</c>) declaration at a <em>user instance method</em> call site was
/// accepted but never declared the local in the enclosing block scope, so a
/// subsequent read of <c>n</c> failed with <c>GS0125</c>. The free-function and
/// imported-method paths already re-bound the first-pass placeholder; the
/// user-instance path (<c>BindUserInstanceCall</c>) did not. These tests cover
/// implicit-<c>this</c> and explicit-receiver calls, the read-only (<c>out
/// let</c>) and discard (<c>out _</c>) forms, and a generic out-parameter.
/// </summary>
public class Issue1133OutVarEnclosingScopeBinderTests
{
    [Fact]
    public void ImplicitThis_OutVar_DeclaresLocalInEnclosingScope_NoGS0125()
    {
        // Exact repro from the issue.
        const string source = @"
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out var y)
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ExplicitReceiver_OutVar_DeclaresLocalInEnclosingScope_NoGS0125()
    {
        const string source = @"
package p
class C {
    func G(out x int32) { x = 5 }
}
class D {
    func F(c C) int32 {
        c.G(out var y)
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void OutLet_DeclaresReadOnlyLocal_ReadIsFine()
    {
        const string source = @"
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out let y)
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void OutLet_AssigningAfterwards_ReportsReadOnly()
    {
        const string source = @"
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out let y)
        y = 9
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void OutDiscard_DoesNotLeakName()
    {
        const string source = @"
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out _)
        return _
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void OutDiscard_AloneCompiles()
    {
        const string source = @"
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out _)
        return 1
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void GenericOutParameter_OutVar_BindsSubstitutedType_NoDiagnostics()
    {
        // The out-var local must bind as the substituted parameter pointee
        // type (int32 here), not the open type parameter `T`.
        const string source = @"
package p
class C {
    func M[T](seed T, out result T) { result = seed }
    func F() int32 {
        M[int32](7, out var y)
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Control_PreDeclaredOutLocal_StillCompiles()
    {
        // Regression guard: the existing pre-declared form must keep working.
        const string source = @"
package p
class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        var y int32
        G(out y)
        return y
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStatic_OutVar_DeclaresLocalInEnclosingScope_NoGS0125()
    {
        // Issue #1139: the qualified static (`C.G(...)`) path was missed by
        // #1137. The exact repro from the issue must declare `y` and read it.
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out var y)
            return y
        }
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStatic_OutLet_ReadIsFine()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out let y)
            return y
        }
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
        func F() int32 {
            C.G(out let y)
            y = 7
            return y
        }
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
        func F() int32 {
            C.G(out _)
            return _
        }
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0125");
    }

    [Fact]
    public void QualifiedStatic_OutVar_ReassignedLater_Compiles()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out var y)
            y = 9
            return y
        }
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void CrossClassQualifiedStatic_OutVar_DeclaresLocal_NoGS0125()
    {
        const string source = @"
package p
class Other {
    shared {
        func G(out x int32) { x = 5 }
    }
}
class C {
    shared {
        func F() int32 {
            Other.G(out var y)
            return y
        }
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
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
