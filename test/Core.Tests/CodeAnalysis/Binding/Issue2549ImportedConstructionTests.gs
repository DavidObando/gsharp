// <copyright file="Issue2549ImportedConstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import Xunit

class Issue2549ImportedConstructionTests {
    @Fact
    func ImportedReferenceTypes_ConstructAndImplicitObjectMethodBinds() {
        let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue2549ImportedConstructionTests")
        Directory.CreateDirectory(outputDirectory)
        let libraryPath = Path.Combine(outputDirectory, "Issue2549.Library.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Issue2549.Library

class Empty { }

class GetType { }

class Named {
    prop Name string

    init(name string) {
        Name = name
    }
}`))){IsLibrary = true}
        {
            using let libraryStream = File.Create(libraryPath)
            let result = library.Emit(libraryStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2549.Library")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Issue2549.Consumer
import System
import Issue2549.Library
import EmptyAlias = Issue2549.Library.Empty
import NamedAlias = Issue2549.Library.Named

type LocalNamed = NamedAlias

class Factory {
    func CreateEmpty() EmptyAlias -> EmptyAlias()
    func CreateNamed() LocalNamed -> LocalNamed("value")
    func RuntimeType() Type -> GetType()
}`)))
        using let consumerStream = MemoryStream()
        let consumerResult = consumer.Emit(
            consumerStream,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue2549.Consumer"
        )
        Assert.True(consumerResult.Success, string.Join(Environment.NewLine, consumerResult.Diagnostics))
    }
}
