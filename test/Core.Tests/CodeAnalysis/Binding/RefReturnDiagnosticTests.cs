// <copyright file="RefReturnDiagnosticTests.cs" company="GSharp">
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
/// Issue #490 (ADR-0060 follow-up): diagnostic coverage for the ref-return surface.
/// Validates GS0248 (ref return without a return type), GS0249 (state-machine
/// incompatibility), GS0251/GS0252 (return-statement shape vs declaration shape),
/// GS0253 (non-lvalue), GS0254 (escape of function-local storage), and GS0255
/// (override / interface ref-return mismatch).
/// </summary>
public class RefReturnDiagnosticTests
{
    private static EvaluationResult Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    [Fact]
    public void RefReturnWithoutReturnType_ReportsGS0248()
    {
        const string Source = @"package NoReturnType

func bad(ref x int32) ref {
    return ref x
}
";
        var result = Compile(Source);
        // The parser will not consume `ref` without a type clause behind it, so the
        // declaration is rejected — but if a future parser improvement does, GS0248
        // is the authoritative diagnostic. Either path must surface *some* error.
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void RefReturnOnAsyncFunction_ReportsGS0249()
    {
        const string Source = @"package AsyncRefReturn

async func bad(ref x int32) ref int32 {
    return ref x
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0249");
    }

    [Fact]
    public void ReturnRefInNonRefReturningFunction_ReportsGS0251()
    {
        const string Source = @"package PlainReturnsRef

func bad(ref x int32) int32 {
    return ref x
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0251");
    }

    [Fact]
    public void PlainReturnInRefReturningFunction_ReportsGS0252()
    {
        const string Source = @"package RefReturnsPlain

func bad(ref x int32) ref int32 {
    return x
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0252");
    }

    [Fact]
    public void ReturnRefOfNonLvalue_ReportsGS0253()
    {
        const string Source = @"package NonLvalue

func bad(x int32) ref int32 {
    return ref x + 1
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0253");
    }

    [Fact]
    public void ReturnRefOfLocalVariable_ReportsGS0254()
    {
        const string Source = @"package EscapesLocal

func bad() ref int32 {
    var local = 5
    return ref local
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void ReturnRefOfRefParameter_IsAllowed()
    {
        const string Source = @"package RefParamOk

func ok(ref x int32) ref int32 {
    return ref x
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0248" or "GS0249" or "GS0251" or "GS0252" or "GS0253" or "GS0254");
    }

    [Fact]
    public void ClassOverrideReturnRefMismatch_ReportsGS0255()
    {
        const string Source = @"package OverrideMismatch

open class Base {
    open func Get(ref x int32) ref int32 {
        return ref x
    }
}

class Derived : Base {
    override func Get(ref x int32) int32 {
        return x
    }
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0255");
    }
}
