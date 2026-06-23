// <copyright file="Issue950ProtectedModifierTests.cs" company="GSharp">
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
/// Issue #950 — the <c>protected</c> access modifier. A <c>protected</c> member
/// is accessible within its declaring type and within types that derive from it
/// (their own bodies), and is inaccessible from unrelated external code. It is
/// only allowed on members of an inheritable <c>open class</c>; structs,
/// non-open/sealed classes, and top-level declarations reject it (GS0380).
/// External access reports GS0379.
/// </summary>
public class Issue950ProtectedModifierTests
{
    [Fact]
    public void ProtectedKeyword_LexesAsModifier()
    {
        Assert.Equal(SyntaxKind.ProtectedKeyword, SyntaxFacts.GetKeywordKind("protected"));
        Assert.Equal("protected", SyntaxFacts.GetText(SyntaxKind.ProtectedKeyword));
    }

    [Fact]
    public void ProtectedField_ParsesWithoutDiagnostics_OnOpenClass()
    {
        var source = @"
open class Base {
    protected var secret int32
}
0
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.DoesNotContain(tree.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void DerivedClass_AccessesInheritedProtectedMember_NoDiagnostics()
    {
        var source = @"
open class Base {
    protected var secret int32
    protected func Reveal() int32 {
        return secret
    }
}

class Derived : Base {
    func Show() int32 {
        secret = 7
        return secret + Reveal()
    }
}

var d = Derived{}
d.Show()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(14, result.Value);
    }

    [Fact]
    public void ExternalCode_ReadsProtectedField_ReportsGS0379()
    {
        var source = @"
open class Base {
    protected var secret int32
}

var b = Base{}
b.secret
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void ExternalCode_CallsProtectedMethod_ReportsGS0379()
    {
        var source = @"
open class Base {
    protected func Reveal() int32 {
        return 1
    }
}

var b = Base{}
b.Reveal()
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void ProtectedMember_OnNonOpenClass_ReportsGS0380()
    {
        var source = @"
class Sealed {
    protected var secret int32
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0380");
    }

    [Fact]
    public void ProtectedMember_OnStruct_ReportsGS0380()
    {
        var source = @"
struct Val {
    protected var x int32
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0380");
    }

    [Fact]
    public void ProtectedMethod_OnOpenClass_NoPlacementDiagnostic()
    {
        var source = @"
open class Base {
    protected func Reveal() int32 {
        return 1
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0380");
    }

    [Fact]
    public void ProtectedTopLevelClass_ReportsGS0380()
    {
        var source = @"
protected class Foo {
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0380");
    }

    [Fact]
    public void UnrelatedClass_CallsProtectedMember_ReportsGS0379()
    {
        // A sibling type that does NOT derive from Base may not reach a
        // protected member, even though both are user types in the same file.
        var source = @"
open class Base {
    protected func Reveal() int32 {
        return 1
    }
}

class Other {
    func Probe(b Base) int32 {
        return b.Reveal()
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
