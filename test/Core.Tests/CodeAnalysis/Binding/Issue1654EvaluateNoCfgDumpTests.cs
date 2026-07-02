// <copyright file="Issue1654EvaluateNoCfgDumpTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1654: <see cref="Compilation.Evaluate(Dictionary{VariableSymbol, object})"/>
/// used to unconditionally write a <c>cfg.dot</c> debug file next to the
/// host application's executable on every call, which threw
/// <see cref="System.UnauthorizedAccessException"/> when that directory was
/// read-only and raced itself under concurrent evaluation. The dump has been
/// removed entirely since nothing in the repository consumed it.
/// </summary>
public class Issue1654EvaluateNoCfgDumpTests
{
    [Fact]
    public void Evaluate_DoesNotWriteCfgDotNextToTestHostExecutable()
    {
        var appPath = System.Environment.GetCommandLineArgs()[0];
        var appDirectory = Path.GetDirectoryName(appPath);
        var cfgPath = Path.Combine(appDirectory!, "cfg.dot");
        if (File.Exists(cfgPath))
        {
            File.Delete(cfgPath);
        }

        var tree = SyntaxTree.Parse(SourceText.From("var a int32 = 1 + 2"));
        var compilation = new Compilation(tree);
        var variables = new Dictionary<VariableSymbol, object>();

        var result = compilation.Evaluate(variables);

        Assert.Empty(result.Diagnostics);
        Assert.False(File.Exists(cfgPath), "Evaluate must not write cfg.dot next to the host executable.");
    }

    [Fact]
    public void Evaluate_ReturnsCorrectValue_UsingCachedBoundProgram()
    {
        var tree = SyntaxTree.Parse(SourceText.From("var a int32 = 1 + 2\na"));
        var compilation = new Compilation(tree);
        var variables = new Dictionary<VariableSymbol, object>();

        var result = compilation.Evaluate(variables);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);

        // BoundProgram is cached; calling Evaluate again on the same
        // Compilation must reuse it and keep returning the same result
        // rather than re-binding (or throwing).
        var second = compilation.Evaluate(variables);
        Assert.Empty(second.Diagnostics);
        Assert.Equal(3, second.Value);
        Assert.Same(compilation.BoundProgram, compilation.BoundProgram);
    }
}
