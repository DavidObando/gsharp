// <copyright file="Issue2067AddressOfMethodAccessibilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2067 (follow-up from #2065 / #2058): <c>&amp;Foo.Method</c> (the
/// method-group-to-delegate / managed-function-pointer conversion, ADR-0122
/// §9) resolves through <see cref="GSharp.Core.CodeAnalysis.Binding.ExpressionBinder"/>'s
/// address-of binder, a separate path from regular calls, so
/// <see cref="AccessibilityChecker.IsAccessible"/> was never consulted there —
/// taking the address of a <c>private</c>/<c>protected</c> static method from
/// outside its declaring type went undiagnosed. Mirrors
/// <c>Issue2058PrivateMethodCallAccessibilityTests</c> for <c>&amp;Method</c>.
/// </summary>
public class Issue2067AddressOfMethodAccessibilityTests
{
    [Fact]
    public void ExternalCode_TakesAddressOfPrivateStaticMethod_ReportsGS0472()
    {
        var source = @"
package P

class Foo {
    shared {
        private func Secret() int32 { return 42 }
    }
}

unsafe func run() {
    let fp *func() int32 = &Foo.Secret
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_TakesAddressOfProtectedStaticMethod_ReportsGS0379NotGS0472()
    {
        var source = @"
package P

open class Foo {
    shared {
        protected func Guarded() int32 { return 7 }
    }
}

unsafe func run() {
    let fp *func() int32 = &Foo.Guarded
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0379");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void InternalCode_TakesAddressOfPrivateStaticMethodFromSameType_NoDiagnostics()
    {
        var source = @"
package P

class Foo {
    shared {
        private func Secret() int32 { return 42 }

        unsafe func run() {
            let fp *func() int32 = &Foo.Secret
        }
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_TakesAddressOfPublicStaticMethod_NoDiagnostics()
    {
        var source = @"
package P

class Foo {
    shared {
        func Reveal() int32 { return 42 }
    }
}

unsafe func run() {
    let fp *func() int32 = &Foo.Reveal
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0472");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0379");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
