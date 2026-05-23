// <copyright file="ClassTests.cs" company="GSharp">
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
/// Phase 3.B.3 (sub-step 1) — <c>class</c> declarations as reference-typed
/// aggregates. Same composite-literal / field-access surface as <c>struct</c>,
/// but assignment and field writes go through reference semantics: aliases
/// observe each other's writes. Methods, inheritance, and <c>open</c> /
/// <c>override</c> land in later sub-steps. Interpreter-only for now.
/// </summary>
public class ClassTests
{
    [Fact]
    public void ClassLiteral_ReadFields()
    {
        var source = @"
type Box class {
    Width int
    Height int
}

var b = Box{Width: 3, Height: 4}
b.Width + b.Height
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ClassAssignment_HasReferenceSemantics()
    {
        var source = @"
type Box class {
    Width int
}

var b = Box{Width: 1}
var c = b
c.Width = 99
b.Width
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void ClassFieldAssignment_MutatesInPlace()
    {
        var source = @"
type Box class {
    Width int
}

var b = Box{Width: 5}
b.Width = 42
b.Width
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void StructAssignment_StillHasValueSemantics()
    {
        // Regression: 3.B.3's IsClass dispatch must not regress struct value-copy.
        var source = @"
type Point struct {
    X int
}

var p = Point{X: 1}
var q = p
q.X = 99
p.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void ClassLiteral_EmptyInitializerZeroes()
    {
        var source = @"
type Box class {
    Width int
    Height int
}

var b = Box{}
b.Width + b.Height
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void DataClass_Rejected()
    {
        // `data class` is intentionally not part of Phase 3 (ADR-0029 limits
        // `data` to `struct`); diagnose at parse time.
        var source = @"
type Foo data class {
    X int
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PrimaryConstructor_PositionalCtorCall()
    {
        // Phase 3.B.3 sub-step 2: Kotlin-style primary ctor — params become
        // public fields of the same name; the class is constructed positionally
        // via `Name(args)`.
        var source = @"
type Point class(X int, Y int) {
}

var p = Point(3, 4)
p.X + p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void PrimaryConstructor_AdditionalBodyFieldZeroInitialized()
    {
        // Body fields not listed in the primary ctor are zero-initialized.
        var source = @"
type Counter class(initial int) {
    Count int
}

var c = Counter(10)
c.initial + c.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void PrimaryConstructor_WrongArgumentCount_Diagnoses()
    {
        var source = @"
type Point class(X int, Y int) {
}

var p = Point(3)
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PrimaryConstructor_WrongArgumentType_Diagnoses()
    {
        var source = @"
type Point class(X int, Y int) {
}

var p = Point(3, true)
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PrimaryConstructor_NameCollidesWithBodyField_Diagnoses()
    {
        var source = @"
type Point class(X int, Y int) {
    X int
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Method_CallReturnsValue_UsingImplicitThis()
    {
        // Phase 3.B.3 sub-step 2b: bare `X` / `Y` inside `Sum` resolve to
        // `this.X` / `this.Y`.
        var source = @"
type Pt class(X int, Y int) {
    func Sum() int {
        return X + Y
    }
}
var p = Pt(3, 4)
p.Sum()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Method_MutatesReceiverViaImplicitFieldAssignment()
    {
        var source = @"
type Pt class(X int, Y int) {
    func Scale(f int) {
        X = X * f
        Y = Y * f
    }
}
var p = Pt(2, 3)
p.Scale(10)
p.X + p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void Method_TakesAndUsesArguments()
    {
        var source = @"
type Vec class(X int) {
    func Add(n int) int {
        return X + n
    }
}
var v = Vec(5)
v.Add(7)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void Method_WrongArgCount_Diagnoses()
    {
        var source = @"
type Pt class(X int) {
    func Inc() int {
        return X + 1
    }
}
var p = Pt(1)
p.Inc(99)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Method_NameCollidesWithField_Diagnoses()
    {
        var source = @"
type Pt class(X int) {
    func X() int {
        return 0
    }
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Method_OnStruct_Diagnoses()
    {
        // Methods are class-only in 3.B.3 sub-step 2b.
        var source = @"
type Pt struct {
    X int

    func Sum() int {
        return X
    }
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
