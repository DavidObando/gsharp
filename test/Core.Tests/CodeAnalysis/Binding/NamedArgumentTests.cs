// <copyright file="NamedArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #343: named arguments at call sites. Covers user-defined free
/// functions, user methods, user constructors, user extension functions,
/// imported CLR static/instance methods, imported CLR constructors, and
/// imported extension methods. Also exercises the diagnostics GS0244–GS0247.
/// </summary>
public class NamedArgumentTests
{
    [Fact]
    public void UserFunction_AllNamed_BindsAndEvaluates()
    {
        var source = @"
func add(x int32, y int32) int32 {
    return x - y
}

let r = add(y: 1, x: 10)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void UserFunction_PositionalThenNamed_BindsAndEvaluates()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(10, y: 3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void UserFunction_InPositionNamedThenPositional_BindsAndEvaluates()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(x: 1, 2)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-1, result.Value);
    }

    [Fact]
    public void UserFunction_OutOfPositionNamedThenPositional_Diagnoses_GS0244()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(y: 1, 2)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0244");
    }

    [Fact]
    public void VariadicFunction_InPositionNamedThenPositional_BindsAndEvaluates()
    {
        var source = @"
func total(additional int32, values ...int32) int32 {
    return additional + values.Length
}

total(additional: 5, 10, 20)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void UserFunction_DuplicateName_Diagnoses_GS0245()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(x: 1, x: 2)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0245");
    }

    [Fact]
    public void UserFunction_UnknownName_Diagnoses_GS0246()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(x: 1, qty: 2)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0246");
    }

    [Fact]
    public void UserFunction_NameAlsoPositional_Diagnoses_GS0247()
    {
        var source = @"
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(1, x: 2)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0247");
    }

    [Fact]
    public void UserMethod_NamedArguments_BindAndEvaluate()
    {
        var source = @"
class Calc {
    var Bias int32

    func Combine(a int32, b int32) int32 {
        return Bias + a * 10 + b
    }
}

let c = Calc{Bias: 100}
let r = c.Combine(b: 7, a: 3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(137, result.Value);
    }

    [Fact]
    public void UserMethod_NamedArgument_SkipsOptionalMiddleParameter()
    {
        var source = @"
class Progress {
    func Emit(phase int32, progress int32? = nil, message string? = nil) string {
        return message!!
    }
}

let progress = Progress()
progress.Emit(1, message: ""ready"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("ready", result.Value);
    }

    [Fact]
    public void UserConstructor_PrimaryCtor_NamedArguments_BindAndEvaluate()
    {
        var source = @"
class Point(X int32, Y int32) {
}

let p = Point(Y: 7, X: 3)
let r = p.X * 10 + p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(37, result.Value);
    }

    [Fact]
    public void UserConstructor_InPositionNamedThenPositional_Binds()
    {
        var source = @"
class Point(X int32, Y int32) {
}

let p = Point(X: 3, 7)
p.X * 10 + p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(37, result.Value);
    }

    [Fact]
    public void UserConstructor_PrimaryCtor_NameAlsoPositional_Diagnoses_GS0247()
    {
        var source = @"
class Point(X int32, Y int32) {
}

let p = Point(1, X: 9)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0247");
    }

    [Fact]
    public void UserExtensionFunction_NamedArguments_BindAndEvaluate()
    {
        var source = @"
class Box {
    var N int32

    func Mix(low int32, high int32) int32 {
        return N + low * 100 + high
    }
}

let b = Box{N: 1}
let r = b.Mix(high: 7, low: 5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(508, result.Value);
    }

    [Fact]
    public void ClrInstance_StringIndexOf_NamedArguments_BindAndEvaluate()
    {
        var source = @"
import System

let s = ""hello world""
let i = s.IndexOf(value: ""world"", startIndex: 0)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ClrConstructor_StringBuilder_NamedArguments_Binds()
    {
        var source = @"
import System.Text

let sb = StringBuilder(capacity: 16)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClrConstructor_UnknownName_Diagnoses_GS0246()
    {
        var source = @"
import System.Text

let sb = StringBuilder(qty: 16)
";
        var result = Evaluate(source);
        AssertHasDiagnosticId(result.Diagnostics, "GS0246");
    }

    [Fact]
    public void FunctionVariable_NamedArguments_BindAndEvaluate()
    {
        var source = @"
let subtract func(int32, int32) int32 = func(x int32, y int32) int32 {
    return x - y
}

subtract(y: 3, x: 10)
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NamedDelegateVariable_NamedArguments_BindAndEvaluate()
    {
        var source = @"
type Operation = delegate func(x int32, y int32) int32

func subtract(x int32, y int32) int32 {
    return x - y
}

let operation Operation = subtract
operation(y: 3, x: 10)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ImportedClrKeywordParameter_UsesCanonicalSuffixedName()
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(KeywordNamedParameterFixture).Assembly.Location });
        var tree = SyntaxTree.Parse(SourceText.From(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

KeywordNamedParameterFixture.Combine(type_: ""cat"", value: 2)
"));
        var compilation = new Compilation(resolver, tree);
        var diagnostics = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray();

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ImportedClrParamsParameter_CollisionUsesCanonicalNames()
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(KeywordNamedParameterFixture).Assembly.Location });
        var tree = SyntaxTree.Parse(SourceText.From(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

KeywordNamedParameterFixture.CombineParams(params__: ""left"", params_: ""right"")
"));
        var compilation = new Compilation(resolver, tree);
        var diagnostics = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray();

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ImportedClrConstructorParamsParameter_CollisionUsesCanonicalNames()
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(KeywordNamedParameterFixture).Assembly.Location });
        var tree = SyntaxTree.Parse(SourceText.From(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

KeywordNamedConstructorFixture(params__: ""left"", params_: ""right"")
"));
        var compilation = new Compilation(resolver, tree);
        var diagnostics = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray();

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ImportedClrGenericMethod_NamedLambdaArguments_InferAndBind()
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(KeywordNamedParameterFixture).Assembly.Location });
        var tree = SyntaxTree.Parse(SourceText.From(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

GenericNamedArgumentFixture.Create(
    name: ""table"",
    columns: (builder GenericNamedArgumentBuilder) -> builder.Value,
    constraints: (value int32) -> {
    })
"));
        var compilation = new Compilation(resolver, tree);
        var diagnostics = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray();

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ImportedConstructedGenericReceiver_NamedLambdaArgument_BindsSymbolically()
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(KeywordNamedParameterFixture).Assembly.Location });
        var tree = SyntaxTree.Parse(SourceText.From(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

class Item {
    var Value int32
}

let receiver = GenericNamedReceiver[Item]()
receiver.Apply(
    name: ""value"",
    selector: (item Item) -> item.Value)
"));
        var compilation = new Compilation(resolver, tree);
        var diagnostics = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray();

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    private static void AssertHasDiagnosticId(ImmutableArray<Diagnostic> diagnostics, string id)
    {
        Assert.Contains(diagnostics, d => d.Id == id);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}

/// <summary>CLR fixture whose parameter name is a reserved G# keyword.</summary>
public static class KeywordNamedParameterFixture
{
    /// <summary>Combines the supplied values.</summary>
    public static string Combine(string type, int value) => $"{type}:{value}";

    /// <summary>Combines colliding source parameter names.</summary>
    public static string CombineParams(string @params, string params_) =>
        @params + params_;
}

/// <summary>CLR constructor fixture with colliding source parameter names.</summary>
public sealed class KeywordNamedConstructorFixture
{
    /// <summary>Initializes a new instance.</summary>
    public KeywordNamedConstructorFixture(string @params, string params_)
    {
    }
}

/// <summary>CLR builder fixture for generic named-lambda calls.</summary>
public sealed class GenericNamedArgumentBuilder
{
    /// <summary>Gets a deterministic value.</summary>
    public int Value => 42;
}

/// <summary>CLR generic call fixture matching migration-builder APIs.</summary>
public static class GenericNamedArgumentFixture
{
    /// <summary>Invokes the supplied delegates.</summary>
    public static T Create<T>(
        string name,
        Func<GenericNamedArgumentBuilder, T> columns,
        Action<T> constraints)
    {
        T value = columns(new GenericNamedArgumentBuilder());
        constraints(value);
        return value;
    }
}

/// <summary>CLR generic receiver fixture for symbolic named lambdas.</summary>
public sealed class GenericNamedReceiver<T>
{
    /// <summary>Accepts a lambda over the receiver's symbolic type.</summary>
    public int Apply(string name, Func<T, int> selector) => 0;
}
