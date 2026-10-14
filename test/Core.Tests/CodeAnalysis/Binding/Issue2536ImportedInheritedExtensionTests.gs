// <copyright file="Issue2536ImportedInheritedExtensionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

class Issue2536ImportedInheritedExtensionTests {
    @Fact
    func LinqExtensions_OnImportedInterfaceWithGenericBase_Bind() {
        let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue2536")
        Directory.CreateDirectory(outputDirectory)
        let libraryPath = Path.Combine(outputDirectory, "Issue2536.Contracts.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Issue2536.Contracts
import System.Collections.Generic

class Item {
    prop Value int32
}

interface IItems : IReadOnlyCollection[Item] {
}`))){IsLibrary = true}
        {
            using let stream = File.Create(libraryPath)
            let result = library.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2536.Contracts")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences(RuntimeReferences().Append(libraryPath))
        Assert.True(resolver.TryResolveType("Issue2536.Contracts.IItems", out var importedItems))
        Assert.Contains(
            importedItems.GetInterfaces(),
            (type Type) -> type.IsGenericType && type.GetGenericTypeDefinition()
                .FullName == typeof(IReadOnlyCollection[_]).FullName &&
                type
                .GetGenericArguments()[0]
                .FullName == "Issue2536.Contracts.Item"
        )
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Issue2536.Consumer
import Issue2536.Contracts
import System.Linq

func Exercise(items IItems) {
    var filtered = items.Where(func(item Item) bool { return item.Value > 0 })
    var any = items.Any(func(item Item) bool { return item.Value > 0 })
    var count = items.Count(func(item Item) bool { return item.Value > 0 })
    var first = items.FirstOrDefault()
}`))){IsLibrary = true}
        using let output = MemoryStream()
        let consumerResult = consumer.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2536.Consumer")
        Assert.True(consumerResult.Success, string.Join(Environment.NewLine, consumerResult.Diagnostics))
    }

    shared {
        private func RuntimeReferences() IEnumerable[string] {
            let trustedAssemblies string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(trustedAssemblies) {
                cast[IEnumerable[string]](Array.Empty[string]())
            } else {
                trustedAssemblies!!.Split(Path.PathSeparator).Where(
                    (path string) -> !string.IsNullOrWhiteSpace(path) && File.Exists(path)
                )
            }
        }
    }
}
