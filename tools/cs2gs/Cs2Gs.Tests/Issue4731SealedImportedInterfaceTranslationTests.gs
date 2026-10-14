// <copyright file="Issue4731SealedImportedInterfaceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import Xunit

class Issue4731SealedImportedInterfaceTranslationTests {
    @Fact
    func SealedProtectedOverride_KeepsSealednessAndBindsInheritedInterfaceCast() {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4731SealedImportedInterfaceTranslationTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let assemblyPath = Path.Combine(directory, "Issue4731.Renderables.dll")
            let contract = CSharpCompilation.Create("Issue4731.Renderables", []SyntaxTree{CSharpSyntaxTree.ParseText(`namespace Issue4731.Renderables;
public interface IRenderable { int Read(); }
public abstract class Renderable : IRenderable
{
    protected abstract int Measure();
    public int Read() => Measure();
}`)}, CSharpProjectLoader.RuntimeReferences(), CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            {
                using let stream = File.Create(assemblyPath)
                let emitted = contract.Emit(stream)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            }
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Consumer.cs", `#nullable enable
using Issue4731.Renderables;
namespace Issue4731.Consumer;

public sealed class Dock : Renderable
{
    private readonly int height = 17;
    protected override int Measure() => height;
}
public static class Consumer
{
    public static IRenderable Build()
    {
        var main = (IRenderable)new Dock();
        return main;
    }
}`)}, CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(assemblyPath)).ToArray())
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.Contains("class Dock : Renderable", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("open class Dock", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("class Dock : Renderable, IRenderable", printed, StringComparison.Ordinal)
            Assert.Contains("protected override func Measure()", printed, StringComparison.Ordinal)
            Assert.Contains("cast[IRenderable](Dock())", printed, StringComparison.Ordinal)
            using let references = ReferenceResolver.WithReferences([]string{assemblyPath})
            Assert.True(references.TryResolveType("Issue4731.Renderables.IRenderable", out var interfaceType))
            Assert.True(interfaceType.IsInterface)
            TranslationTestValidation.AssertBinds(references, printed)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }
}
