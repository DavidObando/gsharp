// <copyright file="Issue2058PrivateMethodCallAccessibilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2058: <see cref="GSharp.Core.CodeAnalysis.Binding.OverloadResolver.BindUserInstanceCall"/>
/// previously only consulted <see cref="AccessibilityChecker.IsAccessible"/>
/// when a called method's accessibility was exactly <c>protected</c>, so a
/// <c>private</c> method called from outside its declaring type was never
/// diagnosed — the same class of hole that issue #2044 fixed for field/
/// property reads and writes, but left open for method calls. This mirrors
/// <c>Issue2044PrivateAccessibilityTests</c>, but exercises method calls
/// specifically.
/// </summary>
public class Issue2058PrivateMethodCallAccessibilityTests
{
    [Fact]
    public void ExternalCode_CallsPrivateMethod_ReportsGS0472()
    {
        var source = @"
class Foo {
    private func Secret() int32 {
        return 42
    }
}

class Other {
    func Poke(f Foo) int32 {
        return f.Secret()
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_CallsPrivateMethodViaChainedReceiver_ReportsGS0472()
    {
        // Issue #2058: same gated path, but reached through a chained member
        // access (`Make().Secret()`) rather than a bare parameter receiver.
        var source = @"
class Foo {
    private func Secret() int32 {
        return 42
    }
}

class Other {
    func Make() Foo {
        return Foo()
    }

    func Poke() int32 {
        return Make().Secret()
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void InternalCode_CallsPrivateMethodFromSameType_NoDiagnostics()
    {
        var source = @"
class Foo {
    private func Secret() int32 {
        return 42
    }

    func Reveal() int32 {
        return Secret()
    }
}

class Other {
    func Poke(f Foo) int32 {
        return f.Reveal()
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void NestedType_CallsEnclosingTypePrivateMethod_NoDiagnostics()
    {
        var source = @"
class Outer {
    private func Secret() int32 {
        return 42
    }

    class Inner {
        func Poke(o Outer) int32 {
            return o.Secret()
        }
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void DerivedClass_CallsBaseProtectedMethod_NoDiagnostics()
    {
        // A derived class calling its base's `protected` method must still
        // compile cleanly — the private-method fix must not accidentally
        // over-broaden the check to also require `protected` methods be
        // publicly visible.
        var source = @"
open class Base {
    protected func Guarded() int32 {
        return 7
    }
}

class Derived : Base {
    func Poke() int32 {
        return Guarded()
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0379");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_CallsProtectedMethod_ReportsGS0379NotGS0472()
    {
        // Issue #2058: the diagnostic reporter must be passed the member's
        // real accessibility, not a hardcoded `protected`, so a `protected`
        // method still reports GS0379 (not GS0472) once the gate covers all
        // non-public accessibilities.
        var source = @"
open class Base {
    protected func Guarded() int32 {
        return 7
    }
}

class Other {
    func Poke(b Base) int32 {
        return b.Guarded()
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
