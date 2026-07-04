// <copyright file="Issue2059StructLiteralAccessibilityTests.cs" company="GSharp">
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
/// Issue #2059: a composite/struct literal <c>Foo{ member: value }</c> writes
/// each named member directly (<c>BoundFieldInitializer</c>), bypassing the
/// qualified-assignment path (<c>receiver.field = value</c>) that #2044/#2048
/// already gate on <c>private</c>/<c>protected</c> accessibility (GS0472 /
/// GS0379). This closes the same gap for literal-init syntax.
/// </summary>
public class Issue2059StructLiteralAccessibilityTests
{
    [Fact]
    public void ExternalCode_LiteralInitsPrivateField_ReportsGS0472()
    {
        var source = @"
class Foo {
    private var Secret int32
}

class Other {
    func Make() Foo {
        return Foo{ Secret: 5 }
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_LiteralInitsPrivateProperty_ReportsGS0472()
    {
        var source = @"
class Foo {
    private prop Secret int32 { get; set }
}

class Other {
    func Make() Foo {
        return Foo{ Secret: 5 }
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void SameType_LiteralInitsOwnPrivateField_NoDiagnostics()
    {
        var source = @"
class Foo {
    private var Secret int32

    func Make(v int32) Foo {
        return Foo{ Secret: v }
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_LiteralInitsPublicField_NoDiagnostics()
    {
        var source = @"
class Foo {
    var Visible int32
}

class Other {
    func Make() Foo {
        return Foo{ Visible: 5 }
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_LiteralInitsInitOnlyProperty_NoDiagnostics()
    {
        var source = @"
class Foo {
    prop Visible int32 { get; init }
}

class Other {
    func Make() Foo {
        return Foo{ Visible: 5 }
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void DerivedType_LiteralInitsProtectedField_NoDiagnostics()
    {
        var source = @"
open class Base {
    protected var Secret int32
}

class Derived : Base {
    func Make(v int32) Derived {
        return Derived{ Secret: v }
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void UnrelatedExternalCode_LiteralInitsProtectedField_ReportsGS0379()
    {
        var source = @"
open class Base {
    protected var Secret int32
}

class Other {
    func Make() Base {
        return Base{ Secret: 5 }
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
