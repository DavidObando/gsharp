// <copyright file="AnonymousClassExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0146 (issue #2243): Kotlin-style anonymous-object literals. Members are
/// newline/semicolon separated (no commas); field types are optional and
/// inferred from the initializer; <c>object : Type</c> / <c>object : Type(args)</c>
/// supply an interface or base class; <c>data object</c> synthesizes value
/// semantics and supports <c>with</c>. Methods and events are permitted; init
/// and deinit are rejected.
/// </summary>
public class AnonymousClassExpressionTests
{
    [Fact]
    public void FieldOnly_InferredTypes_MemberAccessReturnsValue()
    {
        var source = @"
let x = object { let Name = ""Foo""; let Age = 42 }
x.Name
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Foo", result.Value);
    }

    [Fact]
    public void FieldOnly_ExplicitTypes_MemberAccessReturnsValue()
    {
        var source = @"
let x = object { let Name string = ""Foo""; let Age int32 = 42 }
x.Age
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void FieldOnly_MixedInferredAndExplicit_Binds()
    {
        var source = @"
let x = object { let Name = ""Foo""; let Age int32 = 42; let Flag bool = true }
x.Flag
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void FieldOnly_NewlineSeparatedMembers_Binds()
    {
        var source = @"
let x = object {
    let Name = ""David""
    let Language = ""GSharp""
    let Flag bool = true
    let Number int = 42
}
x.Language
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("GSharp", result.Value);
    }

    [Fact]
    public void FieldOnly_CommaSeparator_IsRejected()
    {
        // ADR-0146 hard-breaking change: the old comma-separated member shape
        // is no longer accepted; members are newline/semicolon separated.
        var diagnostics = GetDiagnostics(@"
let x = object { let Name = ""Foo"", let Age = 42 }
");
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void FieldOnly_SameShape_UnifiesToOneSynthesizedType()
    {
        var source = @"
let a = object { let Id int32 = 1; let Alias string = ""x"" }
let b = object { let Id int32 = 2; let Alias string = ""y"" }
1
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);
        Assert.Single(compilation.GlobalScope.AnonymousTypes);
    }

    [Fact]
    public void FieldOnly_DifferentShape_ProducesDifferentTypes()
    {
        var source = @"
let a = object { let Id int32 = 1 }
let b = object { let Id int32 = 1; let Alias string = ""x"" }
1
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, compilation.GlobalScope.AnonymousTypes.Length);
    }

    [Fact]
    public void DataObject_StructuralEquality_MatchesByValue()
    {
        var source = @"
let a = data object { let Id int32 = 1; let Alias string = ""x"" }
let b = data object { let Id int32 = 1; let Alias string = ""x"" }
a == b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DataObject_ToString_ListsMembers()
    {
        var source = @"
let a = data object { let Id int32 = 1; let Alias string = ""x"" }
a.ToString()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Contains("Id", (string)result.Value);
        Assert.Contains("Alias", (string)result.Value);
    }

    [Fact]
    public void DataObject_With_ProducesIndependentCopy()
    {
        var source = @"
let mydata = data object { let Name = ""David""; let Language = ""GSharp"" }
let other = mydata with { Name = ""Amelia"" }
other.Name + "":"" + mydata.Name + "":"" + other.Language
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Amelia:David:GSharp", result.Value);
    }

    [Fact]
    public void DataObject_With_DoesNotMutateOriginal()
    {
        var source = @"
let mydata = data object { let Name = ""David"" }
let other = mydata with { Name = ""Amelia"" }
mydata.Name
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("David", result.Value);
    }

    [Fact]
    public void ImplementsInterface_MethodCallableThroughBothReferences()
    {
        var output = CompileAndRun(@"
import System
interface MouseListener { func onClick() string; }
let listener = object : MouseListener { func onClick() string -> ""Button clicked!"" }
Console.WriteLine(listener.onClick())
let asIface MouseListener = listener
Console.WriteLine(asIface.onClick())
");
        Assert.Equal(
            "Button clicked!" + Environment.NewLine + "Button clicked!" + Environment.NewLine,
            output);
    }

    [Fact]
    public void ExtendsBaseClass_OverriddenMethodRuns()
    {
        var output = CompileAndRun(@"
import System
open class Animal(Name string) { open func SaySomething() string -> ""generic"" }
let dog = object : Animal(""Fluffy"") { override func SaySomething() string -> ""woof!"" }
Console.WriteLine(dog.SaySomething())
");
        Assert.Equal("woof!" + Environment.NewLine, output);
    }

    [Fact]
    public void EventMember_IsEmittedOnSynthesizedType()
    {
        var diagnostics = GetDiagnostics(@"
let e = object { event Clicked () -> void }
");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InitMember_IsRejected()
    {
        var diagnostics = GetDiagnostics(@"
let x = object { init() { } }
");
        Assert.Contains(diagnostics, d => d.Id == "GS0485");
    }

    [Fact]
    public void DeinitMember_IsRejected()
    {
        var diagnostics = GetDiagnostics(@"
let x = object { deinit { } }
");
        Assert.Contains(diagnostics, d => d.Id == "GS0485");
    }

    [Fact]
    public void MissingInterfaceMember_IsReported()
    {
        var diagnostics = GetDiagnostics(@"
interface MouseListener { func onClick() string; func onHover() string; }
let listener = object : MouseListener { func onClick() string -> ""a"" }
");
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void InvalidOverride_NoMatchingBaseMember_IsReported()
    {
        var diagnostics = GetDiagnostics(@"
open class Animal(Name string) { open func SaySomething() string -> ""generic"" }
let dog = object : Animal(""Fluffy"") { override func Bark() string -> ""woof"" }
");
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void FieldOnly_InsideLambda_Binds()
    {
        var source = @"
func project(id int32, alias string) string {
    let f = (i int32, a string) -> object { let Id int32 = i; let Alias string = a }
    let r = f(id, alias)
    return r.Alias
}
project(7, ""hi"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void FieldOnly_InsideExpressionTreeLambda_DoesNotReportGS0473()
    {
        // Issue #2224 (carried forward under ADR-0146): an anonymous-class
        // literal must be legal inside an expression tree, exactly like C#'s
        // `new { ... }`. cs2gs-translated EF Core migrations depend on this.
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

class Row {
    var Id int32
    var Alias string
}

let expr Expression[Func[Row, object]] = (r Row) -> object { let Id = r.Id; let Alias = r.Alias }
");

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0473");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PublicApiBoundary_NarrowsToDeclaredSupertypeOrObject()
    {
        // ADR-0146 Kotlin-style visibility narrowing: a public function that
        // returns an `object { ... }` literal with a custom member (and no
        // declared supertype) exposes only the universal top type `object`, so
        // a caller cannot reach the custom member through the call result...
        var diagnostics = GetDiagnostics(@"
func make() -> object { let Secret = 42 }
let v = make()
let x = v.Secret
");
        Assert.Contains(diagnostics, d => d.Id == "GS0158");

        // ...while assigning the same literal directly to a local `let` keeps
        // full access to the custom member (this is unaffected by the return-type
        // narrowing rule — it never applies to local bindings).
        var okDiagnostics = GetDiagnostics(@"
let v = object { let Secret = 42 }
let x = v.Secret
");
        Assert.Empty(okDiagnostics);
    }

    [Fact]
    public void PublicApiBoundary_WithDeclaredSupertype_NarrowsToThatSupertype()
    {
        // A public function returning `object : SomeInterface { ... }` narrows
        // the call-site's exposed type to SomeInterface: interface members remain
        // callable, but the anonymous body's own custom member does not.
        var diagnostics = GetDiagnostics(@"
interface Greeter { func Greet() string; }
func make() -> object : Greeter { func Greet() string -> ""hi""; let Secret int32 = 42 }
let v = make()
let greeting = v.Greet()
let x = v.Secret
");
        Assert.Empty(diagnostics.Where(d => d.Id != "GS0158"));
        Assert.Contains(diagnostics, d => d.Id == "GS0158");
    }

    [Fact]
    public void PrivateFunction_ReturningAnonymousClassLiteral_RetainsFullAccess()
    {
        // A private function is not a public API boundary, so the Kotlin
        // narrowing rule does not apply: the caller (in the same file) keeps
        // full access to the anonymous type's own custom member.
        var diagnostics = GetDiagnostics(@"
private func make() -> object { func Foo() int32 -> 1; let Secret int32 = 42 }
let v = make()
let a = v.Foo()
let x = v.Secret
");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void LocalVariable_BoundDirectlyToAnonymousClassLiteral_RetainsFullAccess()
    {
        // Regression guard (ADR-0146): a local `let`/`var` binding of an
        // anonymous-class literal is never narrowed — it always keeps the
        // actual synthesized type, full custom-member access included.
        var diagnostics = GetDiagnostics(@"
let v = object { let Secret = 42 }
let x = v.Secret
");
        Assert.Empty(diagnostics);
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return result.Diagnostics;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static string CompileAndRun(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        peStream.Position = 0;

        var context = new AssemblyLoadContext("anon-run", isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(peStream);
            var programType = assembly.GetTypes().First(t => t.Name == "<Program>");
            var entry = programType.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);

            var savedOut = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry.Invoke(
                    null,
                    entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(savedOut);
            }

            return captured.ToString();
        }
        finally
        {
            context.Unload();
        }
    }
}
