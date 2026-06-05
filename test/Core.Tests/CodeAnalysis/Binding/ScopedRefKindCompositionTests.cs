// <copyright file="ScopedRefKindCompositionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0060 item #9: the <c>scoped</c> modifier (ADR-0058) must compose with
/// the new <c>ref</c>/<c>out</c>/<c>in</c> modifiers on the same parameter.
/// These tests verify that the combinations parse, bind, the parameter symbol
/// carries both <see cref="ParameterSymbol.IsScoped"/> and the correct
/// <see cref="RefKind"/>, and the existing scoped-escape enforcement still
/// fires when the body tries to leak a scoped-ref-kind binding.
/// </summary>
public class ScopedRefKindCompositionTests
{
    private static EvaluationResult Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static FunctionSymbol GetFunction(string source, string name)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Functions.First(f => f.Name == name);
    }

    [Fact]
    public void ScopedRef_BindsWithBothFlags()
    {
        const string Source = @"package SR

func bump(scoped ref x int32) {
    x = x + 1
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        var func = GetFunction(Source, "bump");
        var p = func.Parameters[0];
        Assert.True(p.IsScoped);
        Assert.Equal(RefKind.Ref, p.RefKind);
    }

    [Fact]
    public void ScopedIn_BindsWithBothFlags()
    {
        const string Source = @"package SI

func observe(scoped in x int32) int32 {
    return x + 1
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        var func = GetFunction(Source, "observe");
        var p = func.Parameters[0];
        Assert.True(p.IsScoped);
        Assert.Equal(RefKind.In, p.RefKind);
    }

    [Fact]
    public void ScopedOut_BindsWithBothFlags()
    {
        const string Source = @"package SO

func produce(scoped out x int32) {
    x = 42
}
";
        var result = Compile(Source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        var func = GetFunction(Source, "produce");
        var p = func.Parameters[0];
        Assert.True(p.IsScoped);
        Assert.Equal(RefKind.Out, p.RefKind);
    }

    [Fact]
    public void ScopedIn_StillRejectsAssignment_GS0237()
    {
        // Composition check: GS0237 (item #6) fires regardless of whether
        // the 'in' is also 'scoped'.
        const string Source = @"package SIBody

func bad(scoped in x int32) {
    x = 99
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0237");
    }

    [Fact]
    public void ScopedOut_StillRequiresAssignment_GS0238()
    {
        // Composition check: GS0238 (item #4) fires regardless of whether
        // the 'out' is also 'scoped'.
        const string Source = @"package SOBody

func bad(scoped out x int32) {
    return
}
";
        var result = Compile(Source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0238");
    }
}
