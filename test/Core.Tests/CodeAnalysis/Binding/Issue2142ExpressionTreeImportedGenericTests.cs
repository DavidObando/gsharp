// <copyright file="Issue2142ExpressionTreeImportedGenericTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2142 (follow-up to #2130/#2139): a lambda argument must bind to an
/// <c>Expression&lt;Func&lt;T, …&gt;&gt;</c> parameter of an IMPORTED
/// generic-class INSTANCE method whose delegate type argument is the enclosing
/// class's type parameter (substituted at the call site). Before the fix the
/// lambda-&gt;expression-tree candidate was silently discarded during
/// reflection-based overload resolution, so no overload matched and the
/// compiler emitted GS0159 "Cannot find function …" (e.g. EF Core's
/// <c>EntityTypeBuilder&lt;T&gt;.HasKey(Expression&lt;Func&lt;T, object?&gt;&gt;)</c>).
/// </summary>
public class Issue2142ExpressionTreeImportedGenericTests
{
    [Fact]
    public void LambdaBindsToImportedGenericClassInstanceExpressionParameter()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2142");
        Directory.CreateDirectory(outputDir);

        var libraryPath = Path.Combine(outputDir, "Issue2142.Library.dll");
        EmitLibraryAssembly(libraryPath);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Lib

                class Book { prop Id int32 { get set } prop Title string { get set } }

                func Run(repo Repo[Book]) {
                    repo.HasKey((e Book) -> e.Id)
                    repo.HasIndex((e Book) -> e.Title)
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2142.Consumer");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void NonLambdaOverloadOnImportedGenericClassStillResolves()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2142NonLambda");
        Directory.CreateDirectory(outputDir);

        var libraryPath = Path.Combine(outputDir, "Issue2142NonLambda.Library.dll");
        EmitLibraryAssembly(libraryPath);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Lib

                class Book { prop Id int32 { get set } }

                func Run(repo Repo[Book]) {
                    repo.HasKey("Id")
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2142.NonLambda.Consumer");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void GenuineArityMismatchStillFails()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2142Mismatch");
        Directory.CreateDirectory(outputDir);

        var libraryPath = Path.Combine(outputDir, "Issue2142Mismatch.Library.dll");
        EmitLibraryAssembly(libraryPath);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Lib

                class Book { prop Id int32 { get set } }

                func Run(repo Repo[Book]) {
                    repo.HasKey((e Book, x int32) -> e.Id)
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2142.Mismatch.Consumer");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    private static void EmitLibraryAssembly(string libraryPath)
    {
        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Lib
                import System
                import System.Linq.Expressions

                class Repo[T] {
                    func HasKey(key Expression[Func[T, object?]]) {}
                    func HasKey(name string) {}
                    func HasIndex(index Expression[Func[T, object?]]) {}
                }
                """)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2142.Library");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
