// <copyright file="RefKindDefiniteAssignmentTests.cs" company="GSharp">
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
/// ADR-0060 items #4 and #5 — definite-assignment analysis specialized
/// for ref-kind parameters: GS0238 for out-parameters not assigned on
/// every return path, GS0239 for variables passed by `ref` while still
/// unassigned at the call site.
/// </summary>
public class RefKindDefiniteAssignmentTests
{
    private static EvaluationResult Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    [Fact]
    public void OutParameterNotAssigned_ReportsGS0238()
    {
        const string Source = @"package OutDA1

func bad(out a int32) {
    return
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedOnAllPaths_NoDiagnostic()
    {
        const string Source = @"package OutDA2

func ok(out a int32, cond bool) {
    if cond {
        a = 1
    } else {
        a = 2
    }
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedOnOnlyOneBranch_ReportsGS0238()
    {
        const string Source = @"package OutDA3

func bad(out a int32, cond bool) {
    if cond {
        a = 1
    }
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void OutParameterAssignedUnconditionally_NoDiagnostic()
    {
        const string Source = @"package OutDA4

func ok(out a int32) {
    a = 99
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0238");
    }

    [Fact]
    public void RefArgumentUnassigned_ReportsGS0239()
    {
        const string Source = @"package RefDA1

func bump(ref x int32) {
    x = x + 1
}

func caller() {
    var x int32
    bump(&x)
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0239");
    }

    [Fact]
    public void RefArgumentAssigned_NoDiagnostic()
    {
        const string Source = @"package RefDA2

func bump(ref x int32) {
    x = x + 1
}

func caller() {
    var x = 0
    bump(&x)
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0239");
    }

    [Fact]
    public void OutArgumentAssignsForRef_NoDiagnostic()
    {
        const string Source = @"package RefDA3

func produce(out x int32) {
    x = 42
}

func bump(ref x int32) {
    x = x + 1
}

func caller() {
    var x int32
    produce(&x)
    bump(&x)
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0239");
    }
}
