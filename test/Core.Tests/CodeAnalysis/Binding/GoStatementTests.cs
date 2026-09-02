// <copyright file="GoStatementTests.cs" company="GSharp">
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
/// Emitted-oracle coverage for go statement.
/// </summary>
public class GoStatementTests
{
    [Fact]
    public void Go_OnUserFunctionCall_Binds()
    {
        var source = @"
func work() int32 {
    return 1
}

go work()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Go_OnAsyncFunctionCall_Binds()
    {
        var source = @"
async func work() int32 {
    return 1
}

go work()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Go_OnNonCallExpression_Diagnoses()
    {
        var source = @"
let x = 42
go x
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("'go'"));
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        // ADR-0082 / issue #722: gate test fixtures auto-prepend the
        // Go-extensions import so existing `go` tests continue to exercise
        // bind/lower/emit rather than the gate. Issue722-specific gate
        // behaviour is covered by Issue722GoExtensionsImportGateTests.
        var fullSource = source;
        return EmittedOracle.Evaluate(fullSource);
    }
}
