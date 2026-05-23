// <copyright file="InterfaceTests.cs" company="GSharp">
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
/// Phase 3.B.4 — <c>interface</c> declarations. Per ADR-0018 interfaces
/// carry method signatures only (no bodies, no default impls). Classes
/// implement interfaces via the <c>:</c> clause and the binder validates
/// that every required method is present with a matching signature.
/// Interface-typed receivers dispatch to the runtime type's implementation.
/// </summary>
public class InterfaceTests
{
    [Fact]
    public void InterfaceDeclaration_OnlySignatures_Binds()
    {
        var source = @"
type IShape interface {
    func Area() int
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void InterfaceMethodWithBody_ReportsDiagnostic()
    {
        var source = @"
type IBad interface {
    func Area() int { return 0 }
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void ClassImplementsInterface_Dispatches()
    {
        var source = @"
type IShape interface {
    func Area() int
}

type Square class(Side int) : IShape {
    func Area() int { return Side * Side }
}

var s = Square(4)
s.Area()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(16, result.Value);
    }

    [Fact]
    public void ClassMissingInterfaceMethod_ReportsDiagnostic()
    {
        var source = @"
type IShape interface {
    func Area() int
}

type Square class(Side int) : IShape {
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void ClassImplementsMultipleInterfaces()
    {
        var source = @"
type IShape interface {
    func Area() int
}

type INamed interface {
    func Name() string
}

type Square class(Side int) : IShape, INamed {
    func Area() int { return Side * Side }
    func Name() string { return ""square"" }
}

var s = Square(3)
s.Area()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void InterfaceDispatch_PicksRuntimeImpl()
    {
        var source = @"
type IShape interface {
    func Area() int
}

type Box open class(W int) : IShape {
    open func Area() int { return W }
}

type BigBox class(W int) : Box {
    override func Area() int { return W * 10 }
}

var b = BigBox(5)
b.Area()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void SealedInterface_SamePackage_Implementor_Works()
    {
        var source = @"
package GSharp.Tests.Sealed
type IResult sealed interface {
    func Ok() bool
}

type Success class : IResult {
    func Ok() bool { return true }
}

var s = Success{}
s.Ok()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SealedInterface_BodyOnMember_StillDiagnoses()
    {
        var source = @"
type IBad sealed interface {
    func F() int { return 0 }
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void SealedInterface_DifferentPackage_Implementor_Diagnoses()
    {
        var t1 = SyntaxTree.Parse(SourceText.From(@"
package GSharp.Tests.Sealed.A
public type IResult sealed interface {
    func Ok() bool
}
"));
        var t2 = SyntaxTree.Parse(SourceText.From(@"
package GSharp.Tests.Sealed.B
import GSharp.Tests.Sealed.A
type Success class : IResult {
    func Ok() bool { return true }
}
"));
        var compilation = new Compilation(t1, t2);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("sealed interface"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
