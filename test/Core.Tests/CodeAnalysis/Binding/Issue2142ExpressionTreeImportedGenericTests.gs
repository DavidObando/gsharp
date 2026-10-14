// <copyright file="Issue2142ExpressionTreeImportedGenericTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import Xunit

/// Issue #2142 (follow-up to #2130/#2139): a lambda argument must bind to an
/// `Expression<Func<T, …>>` parameter of an IMPORTED
/// generic-class INSTANCE method whose delegate type argument is the enclosing
/// class's type parameter (substituted at the call site). Before the fix the
/// lambda->expression-tree candidate was silently discarded during
/// reflection-based overload resolution, so no overload matched and the
/// compiler emitted GS0159 "Cannot find function …" (e.g. EF Core's
/// `EntityTypeBuilder<T>.HasKey(Expression<Func<T, object?>>)`).
open class Issue2142ExpressionTreeImportedGenericTests {
    @Fact
    func LambdaBindsToImportedGenericClassInstanceExpressionParameter() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2142")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2142.Library.dll")
        EmitLibraryAssembly(libraryPath)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Demo
import Lib

class Book { prop Id int32 { get set } prop Title string { get set } }

func Run(repo Repo[Book]) {
    repo.HasKey((e Book) -> e.Id)
    repo.HasIndex((e Book) -> e.Title)
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2142.Consumer")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func NonLambdaOverloadOnImportedGenericClassStillResolves() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2142NonLambda")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2142NonLambda.Library.dll")
        EmitLibraryAssembly(libraryPath)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Demo
import Lib

class Book { prop Id int32 { get set } }

func Run(repo Repo[Book]) {
    repo.HasKey("Id")
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(
            peStream,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue2142.NonLambda.Consumer"
        )
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func GenuineArityMismatchStillFails() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2142Mismatch")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue2142Mismatch.Library.dll")
        EmitLibraryAssembly(libraryPath)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Demo
import Lib

class Book { prop Id int32 { get set } }

func Run(repo Repo[Book]) {
    repo.HasKey((e Book, x int32) -> e.Id)
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(
            peStream,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue2142.Mismatch.Consumer"
        )
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    shared {
        private func EmitLibraryAssembly(libraryPath string) {
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Lib
import System
import System.Linq.Expressions

class Repo[T] {
    func HasKey(key Expression[Func[T, object?]]) {}
    func HasKey(name string) {}
    func HasIndex(index Expression[Func[T, object?]]) {}
}`))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2142.Library")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
