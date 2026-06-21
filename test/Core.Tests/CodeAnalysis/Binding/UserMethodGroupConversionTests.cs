// <copyright file="UserMethodGroupConversionTests.cs" company="GSharp">
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
/// ADR-0112: converting a user-defined type's <c>shared</c> (static) or instance
/// method to a delegate via a method group — the originally reported bug
/// (<c>Use(Box.Make)</c> -> GS0158, <c>Use(Make)</c> -> GS0125). Covers
/// <c>Type.M</c>, <c>expr.M</c>, bare implicit-<c>this</c>, bare shared, and
/// overloaded selection driven by the target delegate signature.
/// </summary>
public class UserMethodGroupConversionTests
{
    [Fact]
    public void StaticMethodGroup_ViaTypeName_BindsAndInvokes()
    {
        var result = Evaluate(@"
package P

class Box {
    var tag int32
    shared {
        func Make() Box { return Box{ tag: 7 } }
    }
}

func Use(f () -> Box) int32 { return f().tag }

Use(Box.Make)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void InstanceMethodGroup_ViaReceiverExpression_CapturesReceiver()
    {
        var result = Evaluate(@"
package P

class Counter {
    var n int32
    func Get() int32 { return n }
}

func Use(f () -> int32) int32 { return f() }

var c = Counter{ n: 42 }
Use(c.Get)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void BareSharedMethodGroup_InsideMethod_Binds()
    {
        var result = Evaluate(@"
package P

class Factory {
    shared {
        func Make() int32 { return 5 }
    }

    func Build() int32 {
        var f () -> int32 = Make
        return f()
    }
}

var fac = Factory{}
fac.Build()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void BareInstanceMethodGroup_InsideMethod_CapturesThis()
    {
        var result = Evaluate(@"
package P

class Widget {
    var value int32
    func Read() int32 { return value }

    func AsDelegate() int32 {
        var f () -> int32 = Read
        return f()
    }
}

var w = Widget{ value: 9 }
w.AsDelegate()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void OverloadedStaticMethodGroup_SelectsByTargetSignature()
    {
        var result = Evaluate(@"
package P

class Maker {
    shared {
        func Make() int32 { return 1 }
        func Make(x int32) int32 { return x + 1 }
    }
}

func Use(f (int32) -> int32) int32 { return f(10) }

Use(Maker.Make)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void OverloadedInstanceMethodGroup_SelectsByTargetSignature()
    {
        var result = Evaluate(@"
package P

class Adder {
    var bias int32
    func Add() int32 { return bias }
    func Add(x int32) int32 { return bias + x }
}

func Use(f (int32) -> int32) int32 { return f(4) }

var a = Adder{ bias: 100 }
Use(a.Add)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(104, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
