// <copyright file="Issue4731SealedImportedInterfaceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4731SealedImportedInterfaceTranslationTests
{
    [Fact]
    public void SealedProtectedOverride_KeepsSealednessAndBindsInheritedInterfaceCast()
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4731SealedImportedInterfaceTranslationTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string assemblyPath = Path.Combine(directory, "Issue4731.Renderables.dll");
            var contract = CSharpCompilation.Create(
                "Issue4731.Renderables",
                new[]
                {
                    CSharpSyntaxTree.ParseText("""
                        namespace Issue4731.Renderables;
                        public interface IRenderable { int Read(); }
                        public abstract class Renderable : IRenderable
                        {
                            protected abstract int Measure();
                            public int Read() => Measure();
                        }
                        """),
                },
                CSharpProjectLoader.RuntimeReferences(),
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using (var stream = File.Create(assemblyPath))
            {
                var emitted = contract.Emit(stream);
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            }

            var project = CSharpProjectLoader.LoadInMemory(
                new[]
                {
                    ("Consumer.cs", """
                        #nullable enable
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
                        }
                        """),
                },
                CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(assemblyPath)).ToArray());
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
            var document = Assert.Single(project.Documents);
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(
                new CSharpToGSharpTranslator().TranslateDocument(document, context));

            Assert.Contains("class Dock : Renderable", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("open class Dock", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("class Dock : Renderable, IRenderable", printed, StringComparison.Ordinal);
            Assert.Contains("protected override func Measure()", printed, StringComparison.Ordinal);
            Assert.Contains("cast[IRenderable](Dock())", printed, StringComparison.Ordinal);
            using var references = ReferenceResolver.WithReferences(new[] { assemblyPath });
            Assert.True(references.TryResolveType("Issue4731.Renderables.IRenderable", out var interfaceType));
            Assert.True(interfaceType.IsInterface);
            TranslationTestValidation.AssertBinds(references, printed);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
