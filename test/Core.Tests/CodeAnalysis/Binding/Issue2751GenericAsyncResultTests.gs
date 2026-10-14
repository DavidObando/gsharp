// <copyright file="Issue2751GenericAsyncResultTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

class Issue2751GenericAsyncResultTests {
    @Fact
    func OverloadedGenericAsyncCall_HasSingleTaskWrapper() {
        const source = `package Issue2751
import System
import System.Threading.Tasks

async func Read[T](path string) T {
    await Task.Yield()
    throw Exception(path)
}

async func Read[T](directory string, filename string) T {
    return await Read[T](directory + filename)
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError))
        let overload = compilation
            .BoundProgram
            .Functions
            .Keys
            .Single((function FunctionSymbol) -> function.Name == "Read" && function.Parameters.Length == 2)
        let collector = Issue2751GenericAsyncResultTests.CallCollector()
        collector.Visit(compilation.BoundProgram.Functions[overload])
        let call = Assert.Single(collector.Calls)
        let task = Assert.IsType[ImportedTypeSymbol](call.Type)
        Assert.Equal("System.Threading.Tasks.Task`1", task.OpenDefinition!!.FullName)
        Assert.Equal("T", Assert.Single(task.TypeArguments).Name)
        Assert.Equal("T", Assert.Single(call.MethodTypeArguments).Name)
        Assert.IsType[TypeParameterSymbol](call.Function.Type)
    }

    @Fact
    func NonAsyncGenericCall_RemainsNonAwaitable() {
        const source = `package Issue2751Negative

func Read[T](value T) T {
    return value
}

async func Run() int32 {
    return await Read[int32](42)
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        Assert.Contains(compilation.BoundProgram.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0133")
    }

    private class CallCollector : BoundTreeWalker {
        init() {
            Calls = List[BoundCallExpression]()
        }

        prop Calls List[BoundCallExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundCallExpression call {
                Calls.Add(call)
            }
            base.VisitExpression(node)
        }
    }
}
