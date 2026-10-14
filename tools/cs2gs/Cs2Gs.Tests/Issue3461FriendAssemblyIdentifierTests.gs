// <copyright file="Issue3461FriendAssemblyIdentifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharpReferenceResolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver
import GSharpSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #3461: friend-visible inherited members reserve emitted names.
class Issue3461FriendAssemblyIdentifierTests {
    @Fact
    func FriendInternalInheritedName_ReservesDerivedAllocationAtRuntime() {
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue3461FriendAssemblyIdentifierTests")
        Directory.CreateDirectory(directory)
        let libraryPath = Path.Combine(directory, "Friend.Library.dll")
        let library = CSharpCompilation.Create(
            "Friend.Library",
            []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(`using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Friend.Consumer")]

namespace FriendLib;

public class Base
{
    internal int defer_() => 100;
}`)},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        {
            using let stream = File.Create(libraryPath)
            let emit = library.Emit(stream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        }
        let references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(libraryPath))
            .ToArray()
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Consumer.cs", `using FriendLib;

public sealed class Derived : Base
{
    public int @defer() => 7;

    public int Run() => @defer();
}

public static class Holder
{
    public static int Run() => new Derived().Run();
}`)}, references, assemblyName: "Friend.Consumer")
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // ADR-0170: the derived keyword-named method keeps its CLR name via
        // the escape; no allocation around the friend-internal defer_ needed.
        Assert.Contains("func $$defer()", rendered, StringComparison.Ordinal)
        Assert.Contains("func Run() int32 -> $$defer()", rendered, StringComparison.Ordinal)
        using let resolver = GSharpReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Friend.Consumer"
        TranslationTestValidation.AssertBinds(resolver, rendered)
        let compilation = GSharpCompilation(resolver, GSharpSyntaxTree.Parse(GSharpSourceText.From(rendered))){
            IsLibrary = true
        }
        using let image = MemoryStream()
        let result = compilation.Emit(image, pdbStream: nil, refStream: nil, assemblyName: "Friend.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        image.Position = 0
        let loadContext = AssemblyLoadContext(
            "FriendInternalInheritedName_ReservesDerivedAllocationAtRuntime",
            isCollectible: true
        )
        try {
            loadContext.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == "Friend.Library" {
                loadContext.LoadFromAssemblyPath(libraryPath)
            } else {
                default(Assembly?)
            }
            let assembly = loadContext.LoadFromStream(image)
            let holder = assembly.GetTypes().Single(($defer Type) -> $defer.Name == "Holder")
            let run MethodInfo? = holder.GetMethod(
                "Run",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(run)
            Assert.Equal(7, run!!.Invoke(nil, nil))
        } finally {
            loadContext.Unload()
        }
    }
}
