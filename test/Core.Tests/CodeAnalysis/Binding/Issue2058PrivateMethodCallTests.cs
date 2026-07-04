// <copyright file="Issue2058PrivateMethodCallTests.cs" company="GSharp">
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
/// Issue #2058: a <c>private</c> method called from outside its declaring
/// type is now diagnosed (GS0472), mirroring the existing <c>protected</c>
/// method-call enforcement (issue #950 / GS0379) and the field/property
/// enforcement added for issue #2044. Covers instance and static (<c>shared</c>)
/// private methods called from outside the declaring type (must report), and
/// legal same-type, inherited-protected, and public calls (must not report).
/// </summary>
public class Issue2058PrivateMethodCallTests
{
    [Fact]
    public void ExternalCode_CallsPrivateInstanceMethod_ReportsGS0472()
    {
        var source = @"
class Foo {
    private func Secret() int32 { return 42 }
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
    public void ExternalCode_CallsPrivateStaticMethod_ReportsGS0472()
    {
        var source = @"
class Foo {
    shared {
        private func Secret() int32 { return 42 }
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
    public void InternalCode_CallsPrivateInstanceMethodFromSameType_NoDiagnostics()
    {
        var source = @"
class Foo {
    private func Secret() int32 { return 42 }
    func Reveal() int32 { return Secret() }
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
    public void InternalCode_CallsPrivateStaticMethodFromSameType_NoDiagnostics()
    {
        var source = @"
class Foo {
    shared {
        func Reveal() int32 { return Secret() }
        private func Secret() int32 { return 42 }
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
    public void DerivedClass_CallsInheritedProtectedMethod_NoDiagnostics()
    {
        var source = @"
open class Base {
    protected func Helper() int32 { return 1 }
}

class Derived : Base {
    func Poke() int32 { return Helper() }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0379");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_CallsPublicMethod_NoDiagnostics()
    {
        var source = @"
class Foo {
    func Greet() int32 { return 42 }
}

class Other {
    func Poke(f Foo) int32 {
        return f.Greet()
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
