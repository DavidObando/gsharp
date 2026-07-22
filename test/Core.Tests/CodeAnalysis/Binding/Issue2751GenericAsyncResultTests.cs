// <copyright file="Issue2751GenericAsyncResultTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2751GenericAsyncResultTests
{
    [Fact]
    public void OverloadedGenericAsyncCall_HasSingleTaskWrapper()
    {
        const string source = """
            package Issue2751
            import System
            import System.Threading.Tasks

            async func Read[T](path string) T {
                await Task.Yield()
                throw Exception(path)
            }

            async func Read[T](directory string, filename string) T {
                return await Read[T](directory + filename)
            }
            """;

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError));

        var overload = compilation.BoundProgram.Functions.Keys.Single(
            function => function.Name == "Read" && function.Parameters.Length == 2);
        var collector = new CallCollector();
        collector.Visit(compilation.BoundProgram.Functions[overload]);
        var call = Assert.Single(collector.Calls);
        var task = Assert.IsType<ImportedTypeSymbol>(call.Type);

        Assert.Equal("System.Threading.Tasks.Task`1", task.OpenDefinition.FullName);
        Assert.Equal("T", Assert.Single(task.TypeArguments).Name);
        Assert.Equal("T", Assert.Single(call.MethodTypeArguments).Name);
        Assert.IsType<TypeParameterSymbol>(call.Function.Type);
    }

    [Fact]
    public void NonAsyncGenericCall_RemainsNonAwaitable()
    {
        const string source = """
            package Issue2751Negative

            func Read[T](value T) T {
                return value
            }

            async func Run() int32 {
                return await Read[int32](42)
            }
            """;

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };

        Assert.Contains(compilation.BoundProgram.Diagnostics, diagnostic => diagnostic.Id == "GS0133");
    }

    private sealed class CallCollector : BoundTreeWalker
    {
        public List<BoundCallExpression> Calls { get; } = [];

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundCallExpression call)
            {
                Calls.Add(call);
            }

            base.VisitExpression(node);
        }
    }
}
