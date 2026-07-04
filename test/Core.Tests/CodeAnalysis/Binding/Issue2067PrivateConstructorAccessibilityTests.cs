// <copyright file="Issue2067PrivateConstructorAccessibilityTests.cs" company="GSharp">
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
/// Issue #2067 (follow-up from #2065 / #2058): an explicit <c>init(...)</c>
/// constructor resolves through a separate binder path from regular method
/// calls, so <see cref="AccessibilityChecker.IsAccessible"/> was never
/// consulted there — a <c>private</c>/<c>protected</c> constructor called
/// from outside its declaring type went undiagnosed at compile time (the CLR
/// would still reject it at runtime). Mirrors
/// <c>Issue2058PrivateMethodCallAccessibilityTests</c> for constructors.
/// </summary>
public class Issue2067PrivateConstructorAccessibilityTests
{
    [Fact]
    public void ExternalCode_CallsPrivateConstructor_ReportsGS0472()
    {
        var source = @"
class Foo {
    private init() {}
}

class Other {
    func Make() Foo {
        return Foo()
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_CallsProtectedConstructor_ReportsGS0379NotGS0472()
    {
        var source = @"
open class Base {
    protected init() {}
}

class Other {
    func Make() Base {
        return Base()
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void InternalCode_CallsPrivateConstructorFromSameType_NoDiagnostics()
    {
        var source = @"
class Foo {
    private init() {}

    func Make() Foo {
        return Foo()
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void DerivedClass_CallsBaseProtectedConstructor_NoDiagnostics()
    {
        var source = @"
open class Base {
    protected init() {}
}

class Derived : Base {
    init() : base() {}
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0379");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_CallsPublicConstructor_NoDiagnostics()
    {
        var source = @"
class Foo {
    init() {}
}

class Other {
    func Make() Foo {
        return Foo()
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0379");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
