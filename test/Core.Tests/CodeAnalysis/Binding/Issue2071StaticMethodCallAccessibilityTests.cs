// <copyright file="Issue2071StaticMethodCallAccessibilityTests.cs" company="GSharp">
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
/// Issue #2071: <see cref="GSharp.Core.CodeAnalysis.Binding.ExpressionBinder.BindUserTypeStaticCall(TypeSymbol, CallExpressionSyntax)"/>
/// never consulted <see cref="AccessibilityChecker.IsAccessible"/> at all, so
/// a <c>private</c>/<c>protected</c> static (<c>shared</c>) method called
/// from outside its declaring type was never diagnosed — the same class of
/// hole that #2058/#2062 fixed for instance-method calls
/// (<c>OverloadResolver.BindUserInstanceCall</c>), but left open for
/// <c>TypeName.Method()</c> static calls.
/// </summary>
public class Issue2071StaticMethodCallAccessibilityTests
{
    [Fact]
    public void ExternalCode_CallsPrivateStaticMethod_ReportsGS0472()
    {
        var source = @"
class Foo {
    shared {
        private func Secret() int32 {
            return 42
        }
    }
}

class Other {
    func Poke() int32 {
        return Foo.Secret()
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_CallsProtectedStaticMethod_ReportsGS0379NotGS0472()
    {
        var source = @"
open class Base {
    shared {
        protected func Guarded() int32 {
            return 7
        }
    }
}

class Other {
    func Poke() int32 {
        return Base.Guarded()
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void DerivedClass_CallsBaseProtectedStaticMethod_NoDiagnostics()
    {
        var source = @"
open class Base {
    shared {
        protected func Guarded() int32 {
            return 7
        }
    }
}

class Derived : Base {
    func Poke() int32 {
        return Base.Guarded()
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0379");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void InternalCode_CallsPrivateStaticMethodFromSameType_NoDiagnostics()
    {
        var source = @"
class Foo {
    shared {
        private func Secret() int32 {
            return 42
        }

        func Reveal() int32 {
            return Secret()
        }
    }
}

class Other {
    func Poke() int32 {
        return Foo.Reveal()
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_CallsPublicStaticMethod_NoDiagnostics()
    {
        var source = @"
class Foo {
    shared {
        func Open() int32 {
            return 42
        }
    }
}

class Other {
    func Poke() int32 {
        return Foo.Open()
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
