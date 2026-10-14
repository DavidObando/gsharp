// <copyright file="SymbolDocumentationIdProviderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Documentation

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0057 §5: Tests that (cref:SymbolDocumentationIdProvider) generates
/// correct DocIDs for G# source symbols.
open class SymbolDocumentationIdProviderTests {
    @Fact
    func Package_GeneratesNPrefix() {
        let package_ = PackageSymbol("MyNamespace", nil)
        let id string? = SymbolDocumentationIdProvider.GetDocumentationId(package_)
        Assert.Equal("N:MyNamespace", id)
    }

    @Fact
    func SimpleFunction_GeneratesMPrefix() {
        let tree = SyntaxTree.Parse("package Lib\nfunc Greet() {}")
        let compilation = Compilation(tree)
        let func_ = compilation.GlobalScope.Functions.First((f FunctionSymbol) -> f.Name == "Greet")
        let id string? = SymbolDocumentationIdProvider.GetDocumentationId(func_)
        Assert.Equal("M:Lib.Greet", id)
    }

    @Fact
    func FunctionWithParams_IncludesParameterTypes() {
        let tree = SyntaxTree.Parse("package Lib\nfunc Add(a int32, b int32) int32 { return a + b }")
        let compilation = Compilation(tree)
        let func_ = compilation.GlobalScope.Functions.First((f FunctionSymbol) -> f.Name == "Add")
        let id string? = SymbolDocumentationIdProvider.GetDocumentationId(func_)
        Assert.Equal("M:Lib.Add(System.Int32,System.Int32)", id)
    }

    @Fact
    func StructType_GeneratesTPrefix() {
        let tree = SyntaxTree.Parse("package Lib\ndata struct Point { var X int32, Y int32 }")
        let compilation = Compilation(tree)
        let type = compilation.GlobalScope.Structs.First((s StructSymbol) -> s.Name == "Point")
        let id string? = SymbolDocumentationIdProvider.GetDocumentationId(type)
        Assert.Equal("T:Lib.Point", id)
    }

    @Fact
    func StructField_GeneratesFPrefix() {
        let tree = SyntaxTree.Parse("package Lib\ndata struct Point { var X int32, Y int32 }")
        let compilation = Compilation(tree)
        let type = compilation.GlobalScope.Structs.First((s StructSymbol) -> s.Name == "Point")
        let field = type.Fields[0]
        let id string? = SymbolDocumentationIdProvider.GetDocumentationId(field, type)
        Assert.Equal("F:Lib.Point.X", id)
    }

    @Fact
    func FunctionWithRefParam_AppendsAtSign() {
        let tree = SyntaxTree.Parse("package Lib\nfunc Bump(ref x int32) {}")
        let compilation = Compilation(tree)
        let func_ = compilation.GlobalScope.Functions.First((f FunctionSymbol) -> f.Name == "Bump")
        let id string? = SymbolDocumentationIdProvider.GetDocumentationId(func_)
        Assert.Equal("M:Lib.Bump(System.Int32@)", id)
    }

    @Fact
    func FunctionWithOutParam_AppendsAtSign() {
        let tree = SyntaxTree.Parse("package Lib\nfunc Produce(out r int32) {}")
        let compilation = Compilation(tree)
        let func_ = compilation.GlobalScope.Functions.First((f FunctionSymbol) -> f.Name == "Produce")
        let id string? = SymbolDocumentationIdProvider.GetDocumentationId(func_)
        Assert.Equal("M:Lib.Produce(System.Int32@)", id)
    }

    @Fact
    func FunctionWithInParam_AppendsAtSign() {
        let tree = SyntaxTree.Parse("package Lib\nfunc Observe(in v int32) {}")
        let compilation = Compilation(tree)
        let func_ = compilation.GlobalScope.Functions.First((f FunctionSymbol) -> f.Name == "Observe")
        let id string? = SymbolDocumentationIdProvider.GetDocumentationId(func_)
        Assert.Equal("M:Lib.Observe(System.Int32@)", id)
    }

    @Fact
    func FunctionWithMixedParams_OnlyRefKindGetsAtSign() {
        let tree = SyntaxTree.Parse("package Lib\nfunc Mix(a int32, ref b int32, c int32) {}")
        let compilation = Compilation(tree)
        let func_ = compilation.GlobalScope.Functions.First((f FunctionSymbol) -> f.Name == "Mix")
        let id string? = SymbolDocumentationIdProvider.GetDocumentationId(func_)
        Assert.Equal("M:Lib.Mix(System.Int32,System.Int32@,System.Int32)", id)
    }
}
