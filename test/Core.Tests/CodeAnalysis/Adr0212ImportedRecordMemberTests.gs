// <copyright file="Adr0212ImportedRecordMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import Xunit

/// Issue #5441: an imported C# record is a CLR-backed aggregate that already holds the members it inherits, so
/// (cref:SemanticModel.LookupMembers) does not add the members of its base a second time.
open class Adr0212ImportedRecordMemberTests {
    @Fact
    func ImportedRecord_InheritedMembers_AreListedOnce() {
        let libraryPath = EmitCSharpLibrary("namespace Records { public record Person(string Name, int Age); }")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let source = "package Consumer\nimport Records\n\nfunc Run(p Person) {\n    p.GetType() // PRecord\n}\n"
        let tree = GsSyntaxTree.Parse(SourceText.From(source, "consumer.gs"))
        let model = Compilation(resolver, tree).GetSemanticModel(tree)
        let access = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().First()
        let receiver = model.GetReceiverTypeInfo(access.LeftPart).Type!!
        Assert.IsType[StructSymbol](receiver)
        Assert.NotNull(cast[StructSymbol](receiver).ClrType)
        let position = source.IndexOf("// PRecord", StringComparison.Ordinal)
        Assert.Single(model.LookupMembers(position, receiver, "GetType"))
        Assert.Single(model.LookupMembers(position, receiver, "Name"))
        Assert.Single(
            model.LookupMembers(position, receiver, "GetHashCode").Where((m Symbol) -> m.Name == "GetHashCode")
        )
    }

    shared {
        private func EmitCSharpLibrary(recordSource string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Adr0212ImportedRecord")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "CSharpLib5441.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(recordSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "CSharpLib5441",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let peStream = File.Create(libraryPath)
            let emitResult = compilation.Emit(peStream)
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            return libraryPath
        }
    }
}
