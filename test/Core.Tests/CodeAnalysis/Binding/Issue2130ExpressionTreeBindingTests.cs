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

    [Fact]
    public void ConditionalOperator_IsAllowedInsideExpressionTree()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

let expr Expression[Func[int32, int32]] = (x int32) -> x > 0 ? x : -x
");

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0473");
    }

    [Fact]
    public void Indexers_AreAllowedInsideExpressionTree()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

class Repo(data [3]int32) {
    prop this[index int32] int32 -> this.data[index]
}

let expr Expression[Func[int32]] = () -> [3]int32{ 10, 20, 30 }[1] + Repo([3]int32{ 1, 2, 3 })[1]
");

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0473");
    }

    [Fact]
    public void ObjectConstructionAndInitializers_AreAllowedInsideExpressionTree()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

class Box {
    prop Width int32
    prop Height int32
    init() { }
}

let expr Expression[Func[int32]] = () -> Box() { Width = 40, Height = 2 }.Width
");

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0473");
    }

    [Fact]
    public void ArrayCreationAndTypeTests_AreAllowedInsideExpressionTree()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

let expr Expression[Func[object, int32]] = (value object) -> (value is string) ? [2]int32{ (value as string).Length, 40 }[0] : 0
");

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0473");
    }

    [Fact]
    public void NestedLambdaArguments_AreAllowedForDelegateAndExpressionParameters()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

class Helpers {
    shared {
        func UseDelegate(f (int32) -> int32, value int32) int32 {
            return f(value)
        }

        func UseExpression(f Expression[(int32) -> int32], value int32) int32 {
            let compiled = f.Compile()
            return compiled(value)
        }
    }
}

let expr Expression[Func[int32, int32]] = (x int32) -> Helpers.UseDelegate((y int32) -> y + 1, x) + Helpers.UseExpression((z int32) -> z + 1, 0)
");

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0473");
    }

    [Fact]
    public void CollectionInitializer_RemainsRejectedInsideExpressionTree()
    {
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions
import System.Collections.Generic

let expr Expression[Func[List[int32]]] = () -> List[int32]{ 1, 2, 3 }
");

        Assert.Contains(diagnostics, d => d.Id == "GS0473");
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
