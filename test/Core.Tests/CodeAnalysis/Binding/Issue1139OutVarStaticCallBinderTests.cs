// <copyright file="Issue1139OutVarStaticCallBinderTests.cs" company="GSharp">
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
/// Issue #1139 / ADR-0060 (follow-up to #1133): an inline <c>out var n</c> (and
/// <c>out let n</c> / <c>out _</c>) declaration at a <em>qualified static</em>
/// (<c>shared</c>) method call site (<c>C.G(out var y)</c>) was accepted but
/// never declared the local in the enclosing block scope, so a subsequent read
/// of <c>n</c> failed with <c>GS0125</c>. The instance path
/// (<c>BindUserInstanceCall</c>) was fixed by #1137; the static path
/// (<c>BindUserTypeStaticCall</c>) never re-bound the first-pass placeholder.
/// These tests cover the qualified static call, a cross-type-qualified call,
/// the read-only (<c>out let</c>) and discard (<c>out _</c>) forms, and a
/// generic static out-parameter, plus regression guards.
/// </summary>
public class Issue1139OutVarStaticCallBinderTests
{
    [Fact]
    public void QualifiedStatic_OutVar_DeclaresLocalInEnclosingScope_NoGS0125()
    {
        // Exact repro from the issue.
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
    public void CrossTypeQualifiedStatic_OutVar_DeclaresLocalInEnclosingScope_NoGS0125()
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

    [Fact]
    public void QualifiedStatic_OutLet_DeclaresReadOnlyLocal_ReadIsFine()
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
            y = 9
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
    public void QualifiedStatic_OutDiscard_AloneCompiles()
    {
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out _)
            return 1
        }
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void GenericQualifiedStatic_OutVar_BindsSubstitutedType_NoDiagnostics()
    {
        // The out-var local must bind as the substituted parameter pointee
        // type (int32 here), not the open type parameter `T`.
        const string source = @"
package p
class C {
    shared {
        func M[T](seed T, out result T) { result = seed }
        func F() int32 {
            C.M[int32](7, out var y)
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
    public void QualifiedStatic_PreDeclaredOutLocal_StillCompiles()
    {
        // Regression guard: the existing pre-declared form must keep working.
        const string source = @"
package p
class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            var y int32
            C.G(out y)
            return y
        }
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStatic_NormalCallWithoutOutVar_StillBinds()
    {
        // No-regression: a normal qualified static call without an out-var
        // still binds cleanly.
        const string source = @"
package p
class C {
    shared {
        func G(x int32) int32 { return x + 1 }
        func F() int32 {
            return C.G(4)
        }
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStatic_UnknownMethod_StillReportsDiagnostic()
    {
        // No-regression: an unknown qualified static method still reports a
        // diagnostic (the inline-out-var rebind must not swallow it).
        const string source = @"
package p
class C {
    shared {
        func F() int32 {
            C.Missing(out var y)
            return y
        }
    }
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void InstanceForm_OutVar_StillWorks_Regression1137()
    {
        // Regression guard for #1137: the instance path must keep working after
        // the shared-helper refactor.
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

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
