// <copyright file="ByRefPointerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0039: Tests for by-ref pointers — binder rules, lvalue classification, diagnostics.
/// </summary>
public class ByRefPointerTests
{
    [Fact]
    public void AddressOf_Variable_Binds_Successfully()
    {
        var source = @"
var x = 42
var p = &x
";
        // #3215: emitted — the byref-typed top-level var stays a local slot.
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void AddressOf_Constant_Reports_GS9005()
    {
        var source = @"
let x = 42
var p = &x
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9005");
    }

    [Fact]
    public void AddressOf_Literal_Reports_GS9001()
    {
        var source = @"
var p = &42
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9001");
    }

    [Fact]
    public void AddressOf_BinaryExpression_Reports_GS9001()
    {
        var source = @"
var x = 1
var y = 2
var p = &(x + y)
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9001");
    }

    [Fact]
    public void Dereference_NonPointer_Reports_Error()
    {
        var source = @"
var x = 42
var y = *x
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Dereference_Pointer_Binds()
    {
        var source = @"
var x = 42
var p = &x
var y = *p
y
";
        // #3215: emitted — dereference through the byref local round-trips.
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void IntTryParse_With_AddressOf_Binds()
    {
        var source = @"
import System
var result = 0
var ok = Int32.TryParse(""42"", &result)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IntTryParse_Without_AddressOf_Reports_GS9002()
    {
        var source = @"
import System
var result = 0
var ok = Int32.TryParse(""42"", result)
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9002");
    }

    [Fact]
    public void Multiply_Still_Works_As_Binary()
    {
        var source = @"
var a = 3
var b = 4
var c = a * b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void BitwiseAnd_Still_Works_As_Binary()
    {
        var source = @"
var a = 7
var b = 3
var c = a & b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void PointerType_In_Variable_Annotation_Parses()
    {
        // Parser test: *int as a type annotation should parse without errors.
        var source = @"
var x = 42
var p *int32 = &x
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void AddressOf_In_Call_Argument_Position()
    {
        var source = @"
import System
var result = 0
var ok = Int32.TryParse(""123"", &result)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void AddressOf_After_Equals_Sign()
    {
        var source = @"
var x = 10
var p = &x
";
        // #3215: emitted — same shape as AddressOf_Variable_Binds_Successfully.
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void AddressOf_In_Binary_LHS()
    {
        // &x is a valid expression that produces a pointer — using it
        // in binary context should produce a type error (not a parse error).
        var source = @"
var x = 10
var y = &x + 1
";
        var result = Evaluate(source);
        // Should produce an error (can't add pointer + int), not a parse crash.
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
