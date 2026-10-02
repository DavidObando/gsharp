// <copyright file="Adr0195AbstractAndSharedClassTests.cs" company="GSharp">
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
/// ADR-0195 / issue #4674 — the <c>abstract</c> and <c>shared</c> class modifiers.
/// A migrated C# <c>abstract class</c> with no abstract member and a migrated C#
/// <c>static class</c> need a G# spelling that fixes the CLR shape (uninstantiable;
/// <c>abstract sealed</c>), because gsc otherwise infers abstractness only from
/// abstract members and has no static class at all. A <c>shared class</c> declares
/// its members directly in the body and every one of them is shared; it has no
/// <c>shared { }</c> block of its own.
/// </summary>
public class Adr0195AbstractAndSharedClassTests
{
    [Fact]
    public void Parser_RecordsAbstractAndSharedModifiersOnTheClassDeclaration()
    {
        var tree = SyntaxTree.Parse(SourceText.From(@"
abstract class Walker {
    func Visit() int32 { return 1 }
}
shared class Helpers {
    func Twice(x int32) int32 { return x * 2 }
}
open abstract class Both { }
abstract data class Shape(Sides int32)
public shared class Exposed { }
class Outer {
    shared class Inner {
        func One() int32 { return 1 }
    }
    abstract class Base { }
}
"));
        Assert.DoesNotContain(tree.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);

        var declarations = tree.Root.Members.OfType<StructDeclarationSyntax>().ToDictionary(d => d.Identifier.Text);
        Assert.True(declarations["Walker"].IsAbstract);
        Assert.False(declarations["Walker"].IsShared);
        Assert.True(declarations["Helpers"].IsShared);
        Assert.False(declarations["Helpers"].IsAbstract);
        Assert.Equal("Twice", Assert.Single(declarations["Helpers"].Methods).Identifier.Text);
        Assert.Null(declarations["Helpers"].SharedBlock);
        Assert.True(declarations["Both"].IsAbstract);
        Assert.True(declarations["Both"].IsOpen);
        Assert.True(declarations["Shape"].IsAbstract);
        Assert.True(declarations["Shape"].IsData);
        Assert.True(declarations["Exposed"].IsShared);

        var nested = declarations["Outer"].NestedTypes.OfType<StructDeclarationSyntax>().ToDictionary(d => d.Identifier.Text);
        Assert.True(nested["Inner"].IsShared);
        Assert.True(nested["Base"].IsAbstract);
    }

    [Fact]
    public void Parser_StillTreatsAbstractAndSharedAsOrdinaryIdentifiers()
    {
        var tree = SyntaxTree.Parse(SourceText.From(@"
var abstract = 1
var shared = abstract + 1
shared = shared + 1
"));
        Assert.DoesNotContain(tree.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Empty(tree.Root.Members.OfType<StructDeclarationSyntax>());
    }

    [Theory]
    [InlineData("abstract struct S { var x int32 }")]
    [InlineData("shared struct S { var x int32 }")]
    [InlineData("abstract interface I { }")]
    [InlineData("shared enum E { A }")]
    public void Parser_RejectsAbstractAndSharedOnNonClass(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Contains(tree.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void Shared_CombinedWithOtherClassModifiers_ReportsGS0618OnEach()
    {
        var tree = SyntaxTree.Parse(SourceText.From("shared open class A { }\nshared sealed class B { }\nshared abstract class C { }\nshared data class D(X int32) { }\n"));
        var conflicts = tree.Diagnostics.Where(d => d.Id == "GS0618").ToList();
        Assert.Equal(4, conflicts.Count);
        Assert.Equal(new[] { 1, 2, 3, 4 }, conflicts.Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray());
    }

    [Fact]
    public void Shared_OnANonClassHead_ReportsOnlyTheMisplacedModifier_NotAConflict()
    {
        var tree = SyntaxTree.Parse(SourceText.From("shared abstract struct S { var x int32 }\nshared open interface I { }\n"));
        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0618");
        Assert.Contains(tree.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
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
    public void SharedClass_MembersInTheBodyAreShared_AndCalledThroughTheClassName()
    {
        var result = EmittedOracle.Evaluate(@"
shared class Helpers {
    const Factor int32 = 3
    var calls int32
    prop Label string { get { return ""helpers"" } }
    func Triple(x int32) int32 {
        Helpers.calls = Helpers.calls + 1
        return x * Factor
    }
}
Helpers.Triple(5) + Helpers.calls + Helpers.Label.Length
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(15 + 1 + 7, result.Value);
    }

    [Fact]
    public void SharedClass_InitBlockIsTheStaticInitializer()
    {
        var result = EmittedOracle.Evaluate(@"
shared class Config {
    var value int32
    init {
        Config.value = 7
    }
    func Get() int32 { return Config.value }
}
Config.Get()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void SharedClass_CanNestAndBeNestedInAClass()
    {
        var result = EmittedOracle.Evaluate(@"
class Outer {
    shared class Utils {
        func Four() int32 { return 4 }
    }
    func Run() int32 { return Utils.Four() + 1 }
}
Outer{}.Run()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void SharedClass_CannotBeInstantiated()
    {
        var result = EmittedOracle.Evaluate(@"
shared class Helpers {
    func One() int32 { return 1 }
}
var literal = Helpers{}
var call = Helpers()
0
");
        var instantiations = result.Diagnostics.Where(d => d.Id == "GS0386").Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray();
        Assert.Equal(new[] { 5, 6 }, instantiations);
    }

    [Fact]
    public void SharedClass_WithInstanceOnlyDeclarations_ReportsGS0617ForEach()
    {
        var result = EmittedOracle.Evaluate(@"
shared class Helpers {
    init() { }
    deinit { }
    shared {
        func Fine() int32 { return 1 }
    }
}
shared class Primary(X int32) { }
0
");
        var lines = result.Diagnostics.Where(d => d.Id == "GS0617").Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray();
        Assert.Equal(new[] { 3, 4, 5, 9 }, lines);
    }

    [Fact]
    public void SharedClass_WithOpenOrOverrideMembers_ReportsGS0617ForEach()
    {
        // The same members in a `shared { }` block are rejected by the parser; in the body of a
        // shared class they must not be accepted and silently made non-virtual.
        var result = EmittedOracle.Evaluate(@"
shared class Helpers {
    open func A() int32 { return 1 }
    open prop P int32 { get { return 1 } }
    open event E func()
    func Fine() int32 { return 1 }
}
0
");
        var lines = result.Diagnostics.Where(d => d.Id == "GS0617").Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray();
        Assert.Equal(new[] { 3, 4, 5 }, lines);
    }

    [Fact]
    public void SharedClass_WithBaseOrInterface_ReportsGS0619()
    {
        var result = EmittedOracle.Evaluate(@"
open class Base { }
interface IThing { }
shared class A : Base { }
shared class B : IThing { }
0
");
        Assert.Equal(2, result.Diagnostics.Count(d => d.Id == "GS0619"));
    }

    [Fact]
    public void SharedClass_CannotBeBaseClass()
    {
        var result = EmittedOracle.Evaluate(@"
shared class Helpers { }
class Derived : Helpers { }
0
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0181");
    }

    [Fact]
    public void SharedClass_MemberCannotBeProtected()
    {
        var result = EmittedOracle.Evaluate(@"
shared class Helpers {
    protected func Hidden() int32 { return 1 }
}
0
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0380");
    }

    [Fact]
    public void PartialParts_SharedMustAppearOnEveryPart_AbstractOnOnePartSuffices()
    {
        var result = EmittedOracle.Evaluate(@"
abstract partial class A { }
partial class A {
    func F() int32 { return 1 }
}
shared partial class S {
    func G() int32 { return 1 }
}
partial class S { }
var a = A()
0
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0479");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0386" && d.Location.StartLine + 1 == 10);
    }

    [Fact]
    public void PartialParts_SharedBesideAnotherPartsConflictingModifier_ReportsGS0618()
    {
        // `shared` and `abstract` each parse cleanly on their own head; only the merge of the
        // two parts into one type sees the conflict.
        var result = EmittedOracle.Evaluate(@"
shared partial class C {
    func F() int32 { return 1 }
}
abstract partial class C { }
sealed partial class D { }
shared partial class D { }
0
");
        var conflicts = result.Diagnostics.Where(d => d.Id == "GS0618").Select(d => d.Location.StartLine + 1).OrderBy(l => l).ToArray();
        Assert.Equal(new[] { 5, 6 }, conflicts);
    }

    [Fact]
    public void PartialSharedParts_AllCarryingShared_MergeIntoOneSharedClass()
    {
        var result = EmittedOracle.Evaluate(@"
shared partial class S {
    func G() int32 { return 1 }
}
shared partial class S {
    func H() int32 { return 2 }
}
S.G() + S.H()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }
}
