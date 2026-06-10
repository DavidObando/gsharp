// <copyright file="Issue656InitAsPrimaryCtorBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #656 — binder-level tests confirming that the binder identifies the
/// correct "primary ctor" symbol for each constructor configuration. Validates
/// that <c>func init(...)</c> is recognized as a constructor (not a method) and
/// that <see cref="StructSymbol.ExplicitConstructor"/> is populated correctly.
/// </summary>
public class Issue656InitAsPrimaryCtorBinderTests
{
    [Fact]
    public void BareInit_Parameterless_SetsExplicitConstructor()
    {
        var source = @"
type Counter class {
    Value int32
    init() {
        Value = 0
    }
}

var c = Counter()
";
        var (result, structs) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);

        var counter = structs.Single(s => s.Name == "Counter");
        Assert.NotNull(counter.ExplicitConstructor);
        Assert.Empty(counter.ExplicitConstructor.Parameters);
    }

    [Fact]
    public void FuncInit_Parameterless_SetsExplicitConstructor()
    {
        // `func init()` should be treated identically to bare `init()`
        var source = @"
type Counter class {
    Value int32
    func init() {
        Value = 0
    }
}

var c = Counter()
";
        var (result, structs) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);

        var counter = structs.Single(s => s.Name == "Counter");
        Assert.NotNull(counter.ExplicitConstructor);
        Assert.Empty(counter.ExplicitConstructor.Parameters);
    }

    [Fact]
    public void FuncInit_WithParameters_SetsExplicitConstructor()
    {
        var source = @"
type Greeting class {
    Message string
    func init(name string) {
        Message = name
    }
}

var g = Greeting(""hi"")
";
        var (result, structs) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);

        var greeting = structs.Single(s => s.Name == "Greeting");
        Assert.NotNull(greeting.ExplicitConstructor);
        Assert.Single(greeting.ExplicitConstructor.Parameters);
        Assert.Equal("name", greeting.ExplicitConstructor.Parameters[0].Name);
    }

    [Fact]
    public void MultipleInits_SetsExplicitConstructors()
    {
        var source = @"
type Color class {
    R int32
    G int32
    B int32
    init(r int32, g int32, b int32) {
        R = r
        G = g
        B = b
    }
    init(gray int32) {
        R = gray
        G = gray
        B = gray
    }
}

var c = Color(1, 2, 3)
";
        var (result, structs) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);

        var color = structs.Single(s => s.Name == "Color");
        Assert.NotNull(color.ExplicitConstructor);
        Assert.Equal(2, color.ExplicitConstructors.Length);
        Assert.Equal(3, color.ExplicitConstructors[0].Parameters.Length);
        Assert.Single(color.ExplicitConstructors[1].Parameters);
    }

    [Fact]
    public void FuncInit_WithDefaultFields_BindsCleanly()
    {
        var source = @"
type Config class {
    Name string = ""default""
    Count int32
    func init() {
        Count = 7
    }
}

var cfg = Config()
";
        var (result, structs) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);

        var config = structs.Single(s => s.Name == "Config");
        Assert.NotNull(config.ExplicitConstructor);
        Assert.False(config.HasPrimaryConstructor);
    }

    [Fact]
    public void PrimaryCtorAndFuncInit_ReportsError()
    {
        // Mixing primary-ctor param list with explicit init is an error
        var source = @"
type Dual class(Name string) {
    Age int32
    func init(age int32) {
        Age = age
    }
}

var d = Dual(""x"")
";
        var (result, _) = EvaluateAndGetStructs(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void NoInit_NoPrimaryCtor_HasNoExplicitConstructor()
    {
        var source = @"
type Plain class {
    Value int32
}

var p = Plain()
";
        var (result, structs) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);

        var plain = structs.Single(s => s.Name == "Plain");
        Assert.Null(plain.ExplicitConstructor);
        Assert.False(plain.HasPrimaryConstructor);
    }

    [Fact]
    public void PrimaryCtor_Only_HasPrimaryConstructor()
    {
        var source = @"
type Box class(Value int32) { }

var b = Box(42)
";
        var (result, structs) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);

        var box = structs.Single(s => s.Name == "Box");
        Assert.Null(box.ExplicitConstructor);
        Assert.True(box.HasPrimaryConstructor);
    }

    private static (EvaluationResult Result, IEnumerable<StructSymbol> Structs) EvaluateAndGetStructs(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        var structs = compilation.GlobalScope.Structs;
        return (result, structs);
    }
}
