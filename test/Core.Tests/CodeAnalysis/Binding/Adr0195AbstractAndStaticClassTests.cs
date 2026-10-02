// <copyright file="Adr0195AbstractAndStaticClassTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0195 / issue #4674 — the <c>abstract</c> and <c>static</c> class
/// modifiers. A migrated C# <c>abstract class</c> with no abstract member and a
/// migrated C# <c>static class</c> need a G# spelling that fixes the CLR shape
/// (uninstantiable; <c>abstract sealed</c>), because gsc otherwise infers
/// abstractness only from abstract members and has no static class at all.
/// </summary>
public class Adr0195AbstractAndStaticClassTests
{
    [Fact]
    public void Parser_RecordsAbstractAndStaticModifiersOnTheClassDeclaration()
    {
        var tree = SyntaxTree.Parse(SourceText.From(@"
abstract class Walker {
    func Visit() int32 { return 1 }
}
static class Helpers {
    shared {
        func Twice(x int32) int32 { return x * 2 }
    }
}
open abstract class Both { }
abstract data class Shape(Sides int32)
public static class Exposed { }
"));
        Assert.DoesNotContain(tree.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);

        var declarations = tree.Root.Members.OfType<StructDeclarationSyntax>().ToDictionary(d => d.Identifier.Text);
        Assert.True(declarations["Walker"].IsAbstract);
        Assert.False(declarations["Walker"].IsStatic);
        Assert.True(declarations["Helpers"].IsStatic);
        Assert.False(declarations["Helpers"].IsAbstract);
        Assert.True(declarations["Both"].IsAbstract);
        Assert.True(declarations["Both"].IsOpen);
        Assert.True(declarations["Shape"].IsAbstract);
        Assert.True(declarations["Shape"].IsData);
        Assert.True(declarations["Exposed"].IsStatic);
    }

    [Fact]
    public void Parser_StillTreatsAbstractAndStaticAsOrdinaryIdentifiers()
    {
        var tree = SyntaxTree.Parse(SourceText.From(@"
var abstract = 1
var static = abstract + 1
"));
        Assert.DoesNotContain(tree.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Empty(tree.Root.Members.OfType<StructDeclarationSyntax>());
    }

    [Theory]
    [InlineData("abstract struct S { var x int32 }")]
    [InlineData("static struct S { var x int32 }")]
    [InlineData("abstract interface I { }")]
    [InlineData("static enum E { A }")]
    public void Parser_RejectsAbstractAndStaticOnNonClass(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Contains(tree.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void Static_CombinedWithOtherClassModifiers_ReportsGS0618OnEach()
    {
        var tree = SyntaxTree.Parse(SourceText.From("static open class A { }\nstatic sealed class B { }\nstatic abstract class C { }\nstatic data class D(X int32) { }\n"));
        var conflicts = tree.Diagnostics.Where(d => d.Id == "GS0618").ToList();
        Assert.Equal(4, conflicts.Count);
        Assert.Equal(new[] { 1, 2, 3, 4 }, conflicts.Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray());
    }

    [Fact]
    public void AbstractClassWithoutAbstractMembers_CannotBeInstantiated()
    {
        var result = EmittedOracle.Evaluate(@"
abstract class Walker {
    func Visit() int32 { return 1 }
}
var literal = Walker{}
var call = Walker()
0
");
        var instantiations = result.Diagnostics.Where(d => d.Id == "GS0386").Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray();
        Assert.Equal(new[] { 5, 6 }, instantiations);
    }

    [Fact]
    public void AbstractClass_IsInheritable_AndMembersMayBeOpenOrProtected()
    {
        var result = EmittedOracle.Evaluate(@"
abstract class Walker {
    protected var count int32
    protected open func Visit() int32 { return 1 }
    open func Describe() string { return ""walker"" }
}
open class Counting : Walker {
    protected override func Visit() int32 { return 2 }
    func Run() int32 { return Visit() }
}
var c = Counting{}
c.Run()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void AbstractClass_SubclassMustStillOverrideAbstractMembers()
    {
        var result = EmittedOracle.Evaluate(@"
abstract class Walker {
    open func Visit() int32;
}
class Counting : Walker { }
0
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0387");
    }

    [Fact]
    public void StaticClass_HoldsSharedMembers_AndIsCalledThroughItsName()
    {
        var result = EmittedOracle.Evaluate(@"
static class Helpers {
    shared {
        const Factor int32 = 3
        var calls int32
        func Triple(x int32) int32 {
            calls = calls + 1
            return x * Factor
        }
    }
}
Helpers.Triple(5) + Helpers.calls
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(16, result.Value);
    }

    [Fact]
    public void StaticClass_CannotBeInstantiated()
    {
        var result = EmittedOracle.Evaluate(@"
static class Helpers {
    shared {
        func One() int32 { return 1 }
    }
}
var literal = Helpers{}
var call = Helpers()
0
");
        var instantiations = result.Diagnostics.Where(d => d.Id == "GS0386").Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray();
        Assert.Equal(new[] { 7, 8 }, instantiations);
    }

    [Fact]
    public void StaticClass_WithInstanceMembers_ReportsGS0617ForEach()
    {
        var result = EmittedOracle.Evaluate(@"
static class Helpers {
    var field int32
    func Instance() int32 { return 1 }
    prop Value int32 { get { return 1 } }
    init() { }
    shared {
        func Fine() int32 { return 1 }
    }
}
0
");
        var members = result.Diagnostics.Where(d => d.Id == "GS0617").Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray();
        Assert.Equal(new[] { 3, 4, 5, 6 }, members);
    }

    [Fact]
    public void StaticClass_WithPrimaryConstructor_ReportsGS0617()
    {
        var result = EmittedOracle.Evaluate("static class Helpers(X int32) { }\n0\n");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0617");
    }

    [Fact]
    public void StaticClass_WithBaseOrInterface_ReportsGS0619()
    {
        var result = EmittedOracle.Evaluate(@"
open class Base { }
interface IThing { }
static class A : Base { }
static class B : IThing { }
0
");
        Assert.Equal(2, result.Diagnostics.Count(d => d.Id == "GS0619"));
    }

    [Fact]
    public void StaticClass_CannotBeBaseClass()
    {
        var result = EmittedOracle.Evaluate(@"
static class Helpers { }
class Derived : Helpers { }
0
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0181");
    }

    [Fact]
    public void PartialParts_AbstractOrStaticOnOnePartAppliesToTheWholeType()
    {
        // A part contributed by a source generator cannot know the other parts'
        // modifiers, so (as in C#) one part stating `abstract`/`static` suffices.
        var result = EmittedOracle.Evaluate(@"
abstract partial class A { }
partial class A {
    func F() int32 { return 1 }
}
partial class S {
    shared {
        func G() int32 { return 1 }
    }
}
static partial class S { }
var a = A()
var s = S()
0
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0479");
        var instantiations = result.Diagnostics.Where(d => d.Id == "GS0386").Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray();
        Assert.Equal(new[] { 12, 13 }, instantiations);
    }
}
