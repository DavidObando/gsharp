// <copyright file="Issue2531ImportedPropertyHidingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import Xunit

class Issue2531ImportedPropertyHidingTests {
    @Fact
    func CSharpProducer_DerivedSameNamedProperties_ReadAndWrite() {
        let libraryPath = EmitCSharpLibrary()
        AssertConsumerCompiles(libraryPath, "CSharpProducer")
    }

    @Fact
    func GSharpProducer_DerivedSameNamedProperties_ReadAndWrite() {
        let libraryPath = EmitGSharpLibrary()
        AssertConsumerCompiles(libraryPath, "GSharpProducer")
    }

    shared {
        private func AssertConsumerCompiles(libraryPath string, producerNamespace string) {
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From((`package Consumer
import System
import ` + "$producerNamespace" + `

func Read(c C) {
    c.P = "derived"
    let derivedValue string = c.P
    c.Q = 2
    let sameTypeValue int32 = c.Q

    let a A = c
    a.P = Object()
    let baseValue object = a.P
}`))))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func EmitCSharpLibrary() string {
            const source = `#nullable enable

namespace CSharpProducer;

public class A
{
    public object P { get; set; } = new();
    public int Q { get; set; }
}

public class B : A
{
    public new string P { get; set; } = "";
    public new int Q { get; set; }
}

public sealed class C : B;`
            let outputPath = GetOutputPath("CSharpProducer.dll")
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "CSharpProducer",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func EmitGSharpLibrary() string {
            const source = `package GSharpProducer

open class A {
    prop P object { get; set; }
    prop Q int32 { get; set; }
}

open class B : A {
    prop P string { get; set; }
    prop Q int32 { get; set; }
}

class C : B {
}`
            let outputPath = GetOutputPath("GSharpProducer.dll")
            let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(source)))
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "GSharpProducer")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func GetOutputPath(fileName string) string {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue2531ImportedPropertyHidingTests")
            Directory.CreateDirectory(outputDirectory)
            return Path.Combine(outputDirectory, fileName)
        }
    }
}
