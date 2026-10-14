// <copyright file="Issue2459NestedImportedClrMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

open class Issue2459NestedImportedClrMemberTests {
    @Fact
    func NestedImportedFieldAndProperty_ResolveLikeMethod() {
        let libraryPath = EmitCSharpLibrary(`namespace ReproLib;

public sealed class A
{
    public B Field = new();
    public B Property { get; } = new();
}

public sealed class B
{
    public int Field = 1;
    public int Property { get; } = 2;
    public event System.Action Changed;
    public int Method() => 3;
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Consumer
import ReproLib

func Read() int32 {
    let a = A()
    a.Field.Changed += () -> { }
    return a.Field.Field + a.Property.Property + a.Field.Method()
}`)))
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0158")
    }

    shared {
        private func EmitCSharpLibrary(source string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2459")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "ReproLib.dll")
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "ReproLib",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(libraryPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }
    }
}
