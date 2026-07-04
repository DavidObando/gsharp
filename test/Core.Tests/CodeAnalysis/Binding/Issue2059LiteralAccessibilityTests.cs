// <copyright file="Issue2059LiteralAccessibilityTests.cs" company="GSharp">
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
/// Issue #2059: a composite/struct literal member initializer
/// (<c>Foo{ Secret: v }</c>), a <c>with</c>-expression field update
/// (<c>p with { Secret = v }</c>), and an object-initializer-suffix member
/// write (<c>Foo(){ Secret = v }</c>) are all writes to the named member —
/// each now enforces the same <c>protected</c>/<c>private</c> accessibility
/// rule as a plain assignment (issue #950 / #2044), reusing
/// <see cref="Symbols.AccessibilityChecker.IsAccessible"/> and
/// <see cref="DiagnosticBag.ReportMemberInaccessible"/>.
/// </summary>
public class Issue2059LiteralAccessibilityTests
{
    [Fact]
    public void ExternalCode_StructLiteralInitsPrivateField_ReportsGS0472()
    {
        var source = @"
class Foo {
    private var Secret int32
}

class Other {
    func Poke() int32 {
        let f = Foo{Secret: 42}
        return 0
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_StructLiteralInitsProtectedField_ReportsGS0379()
    {
        var source = @"
open class Foo {
    protected var Secret int32
}

class Other {
    func Poke() int32 {
        let f = Foo{Secret: 42}
        return 0
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void ExternalCode_StructLiteralInitsPrivateProperty_ReportsGS0472()
    {
        var source = @"
class Foo {
    private prop Secret int32 { get; set }
}

class Other {
    func Poke() int32 {
        let f = Foo{Secret: 42}
        return 0
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void SameType_StructLiteralInitsPrivateField_NoDiagnostics()
    {
        var source = @"
class Foo {
    private var Secret int32

    static func Make(v int32) Foo {
        return Foo{Secret: v}
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_StructLiteralInitsPublicField_NoDiagnostics()
    {
        var source = @"
class Foo {
    var Value int32
}

class Other {
    func Poke() int32 {
        let f = Foo{Value: 42}
        return f.Value
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void ExternalCode_WithExpressionUpdatesPrivateField_ReportsGS0472()
    {
        var source = @"
data struct Point {
    private var x int32
    var y int32
}

class Other {
    func Poke(p Point) Point {
        return p with { x = 10 }
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void SameType_WithExpressionUpdatesPrivateField_NoDiagnostics()
    {
        var source = @"
data struct Point {
    private var x int32
    var y int32

    func Bump() Point {
        return this with { x = 10 }
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_ObjectInitializerSuffixWritesPrivateField_ReportsGS0472()
    {
        var source = @"
class Foo {
    private var Secret int32
}

class Other {
    func Poke() int32 {
        let f = Foo(){Secret = 42}
        return 0
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
