// <copyright file="Issue2044PrivateMemberWriteTests.cs" company="GSharp">
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
/// Issue #2044 (follow-up to #950) — a <c>private</c> member is accessible
/// only within its own declaring type's body, unlike <c>protected</c> (which
/// also allows derived types). Reading, writing, and calling a private
/// member from outside the declaring type all report GS0379, mirroring the
/// existing <c>protected</c> checks exercised in
/// <see cref="Issue950ProtectedModifierTests"/>.
/// </summary>
public class Issue2044PrivateMemberWriteTests
{
    [Fact]
    public void ExternalCode_WritesPrivateField_ReportsGS0379()
    {
        var source = @"
class Foo {
    private var secret int32
}

var f = Foo{}
f.secret = 5
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void ExternalCode_ReadsPrivateField_ReportsGS0379()
    {
        var source = @"
class Foo {
    private var secret int32
}

var f = Foo{}
f.secret
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void ExternalCode_CompoundAssignsPrivateField_ReportsGS0379()
    {
        var source = @"
class Foo {
    private var secret int32
}

var f = Foo{}
f.secret += 1
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void ExternalCode_WritesPrivateProperty_ReportsGS0379()
    {
        var source = @"
class Foo {
    private var _v int32
    private prop V int32 {
        get { return _v }
        set { _v = value }
    }
}

var f = Foo{}
f.V = 3
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void DeclaringType_WritesOwnPrivateField_NoDiagnostics()
    {
        var source = @"
class Foo {
    private var secret int32
    func Set(v int32) void {
        secret = v
    }
    func Get() int32 {
        return secret
    }
}

var f = Foo{}
f.Set(3)
f.Get()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ExternalCode_WritesBasePrivateFieldViaDerivedInstance_ReportsGS0379()
    {
        // Unlike `protected`, `private` is not inherited: a private field
        // declared on Base is inaccessible even via a Derived instance,
        // from code outside Base.
        var source = @"
open class Base {
    private var secret int32
}

class Derived : Base {
}

var d = Derived{}
d.secret = 5
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
