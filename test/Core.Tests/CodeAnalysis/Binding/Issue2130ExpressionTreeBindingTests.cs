// <copyright file="Issue2130ExpressionTreeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2130: binding diagnostics for expression-tree conversions.
/// </summary>
public class Issue2130ExpressionTreeBindingTests
{
    [Fact]
    public void StatementBodyLambda_IsRejectedForExpressionTree()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

let expr Expression[Func[int32, int32]] = (x int32) -> { return x + 1 }
");

        Assert.Contains(diagnostics, d => d.Id == "GS0473" && d.Message.Contains("statement body"));
    }

    [Fact]
    public void AsyncLambda_IsRejectedForExpressionTree()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions
import System.Threading.Tasks

let expr Expression[Func[int32, Task[int32]]] = async (x int32) -> x + 1
");

        Assert.Contains(diagnostics, d => d.Id == "GS0473" && d.Message.Contains("async lambda"));
    }

    [Fact]
    public void AssignmentInsideExpressionTree_IsRejected()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

var outer = 1
let expr Expression[Func[int32, int32]] = (x int32) -> outer = x
");

        Assert.Contains(diagnostics, d => d.Id == "GS0473" && d.Message.Contains("assignment"));
    }

    [Fact]
    public void TupleLiteral_IsRejected()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

let expr Expression[Func[int32, (int32, int32)]] = (x int32) -> (x, x + 1)
");

        Assert.Contains(diagnostics, d => d.Id == "GS0473" && d.Message.Contains("tuple"));
    }

    [Fact]
    public void NonDelegateExpressionTreeTarget_IsRejected()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

let expr Expression[int32] = (x int32) -> x
");

        Assert.Contains(diagnostics, d => d.Id == "GS0474");
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        var result = compilation.Emit(peStream);
        return result.Diagnostics;
    }
}
