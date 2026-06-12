// <copyright file="LetFieldBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0067 / issue #694: binder tests for `let` (read-only) fields on
/// user-declared types.
/// </summary>
public class LetFieldBindingTests
{
    [Fact]
    public void LetField_ReassignmentReportsCannotAssign()
    {
        const string source = "package P\nclass Counter {\n  let Value int32 = 0\n  init() {}\n}\nvar c = Counter()\nc.Value = 1\n";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void VarField_ReassignmentAllowed()
    {
        const string source = "package P\nclass Counter {\n  var Value int32 = 0\n  init() {}\n}\nvar c = Counter()\nc.Value = 1\n";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0127");
    }

    private static System.Collections.Generic.IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }
}

