// <copyright file="Issue2536ImportedInheritedExtensionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2536ImportedInheritedExtensionTests
{
    [Fact]
    public void LinqExtensions_OnImportedInterfaceWithGenericBase_Bind()
    {
        string outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue2536");
        Directory.CreateDirectory(outputDirectory);
        string libraryPath = Path.Combine(outputDirectory, "Issue2536.Contracts.dll");

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Issue2536.Contracts
                import System.Collections.Generic

                class Item {
                    prop Value int32
                }

                interface IItems : IReadOnlyCollection[Item] {
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var stream = File.Create(libraryPath))
        {
            var result = library.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2536.Contracts");
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        using var resolver = ReferenceResolver.WithReferences(RuntimeReferences().Append(libraryPath));
        Assert.True(resolver.TryResolveType("Issue2536.Contracts.IItems", out var importedItems));
        Assert.Contains(
            importedItems.GetInterfaces(),
            type => type.IsGenericType
                && type.GetGenericTypeDefinition().FullName == typeof(IReadOnlyCollection<>).FullName
                && type.GetGenericArguments()[0].FullName == "Issue2536.Contracts.Item");
        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Issue2536.Consumer
                import Issue2536.Contracts
                import System.Linq

                func Exercise(items IItems) {
                    var filtered = items.Where(func(item Item) bool { return item.Value > 0 })
                    var any = items.Any(func(item Item) bool { return item.Value > 0 })
                    var count = items.Count(func(item Item) bool { return item.Value > 0 })
                    var first = items.FirstOrDefault()
                }
                """)))
        {
            IsLibrary = true,
        };

        using var output = new MemoryStream();
        var consumerResult = consumer.Emit(
            output,
            pdbStream: null,
            refStream: null,
            assemblyName: "Issue2536.Consumer");
        Assert.True(consumerResult.Success, string.Join(Environment.NewLine, consumerResult.Diagnostics));
    }

    private static IEnumerable<string> RuntimeReferences()
    {
        var trustedAssemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(trustedAssemblies)
            ? Array.Empty<string>()
            : trustedAssemblies.Split(Path.PathSeparator)
                .Where(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path));
    }
}
