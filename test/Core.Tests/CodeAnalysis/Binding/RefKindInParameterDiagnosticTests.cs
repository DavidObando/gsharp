// <copyright file="RefKindInParameterDiagnosticTests.cs" company="GSharp">
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
/// ADR-0060 item #6: body-side enforcement that an <c>in</c> parameter
/// cannot be assigned or have its address taken — diagnostics fire as
/// GS0237 with ADR-specific wording (not the generic GS0028 / GS9005).
/// </summary>
public class RefKindInParameterDiagnosticTests
{
    private static EvaluationResult Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    [Fact]
    public void InParameterDirectAssignment_ReportsGS0237()
    {
        const string Source = @"package InAssign

func bad(in x int32) {
    x = 5
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0237");
    }

    [Fact]
    public void InParameterAddressOf_ReportsGS0237()
    {
        const string Source = @"package InAddrOf

func bad(in x int32) {
    let p = &x
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0237");
    }

    [Fact]
    public void RefParameterAssignment_DoesNotReportGS0237()
    {
        const string Source = @"package RefAssign

func ok(ref x int32) {
    x = 5
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0237");
    }

    [Fact]
    public void InParameterRead_IsAllowed()
    {
        const string Source = @"package InRead

func ok(in x int32) int32 {
    return x + 1
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0237");
    }
}
