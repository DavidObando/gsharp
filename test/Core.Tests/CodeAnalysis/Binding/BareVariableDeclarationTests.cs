// <copyright file="BareVariableDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Tests for `var` declarations that omit their initializer (e.g. `var x int32`).
/// Such declarations are valid when an explicit type clause is present and take
/// the type's default (zero) value. `let`/`const` remain initializer-required.
/// </summary>
public class BareVariableDeclarationTests
{
    [Fact]
    public void BareVarDeclaration_Int32_DefaultsToZero()
    {
        var source = @"
var x int32
x
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void BareVarDeclaration_Bool_DefaultsToFalse()
    {
        var source = @"
var b bool
b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void BareVarDeclaration_String_TopLevel_DefaultsToNil()
    {
        // ADR-0100 / issue #795: `default(T)` aligned the interpreter
        // with the IL emit path. Reference types (including `string`)
        // default to `nil` rather than the Go-style empty value. Both
        // bare `var s string` (which lowers to `BoundDefaultExpression`)
        // and explicit `default(string)` now produce the same value.
        //
        // Issue #3324 (ADR-0008): this pin is specifically for a TOP-LEVEL
        // `var s string` — a top-level declaration binds a
        // GlobalVariableSymbol (emitted as a static field), which keeps the
        // CLR-default `null` by the same already-settled contract as
        // class/struct fields (issue #1714 / PR #2788 /
        // Issue1714StringZeroValueEmitTests). A genuine function-local
        // `var s string` now zero-inits to `""` per ADR-0008's documented
        // Go-style string zero value — see the `EndToEnd_LocalString*` facts
        // in Issue1714StringZeroValueEmitTests for that (different,
        // local-only) contract.
        var source = @"
var s string
s
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.Value);
    }

    [Fact]
    public void BareVarDeclaration_ThenAssignment_UsesAssignedValue()
    {
        var source = @"
var x int32
x = 42
x
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void BareLetDeclaration_WithoutInitializer_ReportsDiagnostic()
    {
        var source = @"
let x int32
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void BareConstDeclaration_WithoutInitializer_ReportsDiagnostic()
    {
        var source = @"
const x int32
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void BareVarDeclaration_WithoutTypeClause_ReportsDiagnostic()
    {
        var source = @"
var x
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
