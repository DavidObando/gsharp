// <copyright file="Issue2549ImportedConstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2549ImportedConstructionTests
{
    [Fact]
    public void ImportedReferenceTypes_ConstructAndImplicitObjectMethodBinds()
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2549ImportedConstructionTests));
        Directory.CreateDirectory(outputDirectory);
        var libraryPath = Path.Combine(outputDirectory, "Issue2549.Library.dll");
        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Issue2549.Library

                class Empty { }

                class GetType { }

                class Named {
                    prop Name string

                    init(name string) {
                        Name = name
                    }
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var libraryStream = File.Create(libraryPath))
        {
            var result = library.Emit(libraryStream, pdbStream: null, refStream: null, assemblyName: "Issue2549.Library");
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Issue2549.Consumer
                import System
                import Issue2549.Library
                import EmptyAlias = Issue2549.Library.Empty
                import NamedAlias = Issue2549.Library.Named

                type LocalNamed = NamedAlias

                class Factory {
                    func CreateEmpty() EmptyAlias -> EmptyAlias()
                    func CreateNamed() LocalNamed -> LocalNamed("value")
                    func RuntimeType() Type -> GetType()
                }
                """)));

        using var consumerStream = new MemoryStream();
        var consumerResult = consumer.Emit(
            consumerStream,
            pdbStream: null,
            refStream: null,
            assemblyName: "Issue2549.Consumer");

        Assert.True(consumerResult.Success, string.Join(Environment.NewLine, consumerResult.Diagnostics));
    }
}
