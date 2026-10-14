// <copyright file="Issue2731NaturalMethodGroupInterpolationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Runtime and ILVerify coverage for issue #2731.
class Issue2731NaturalMethodGroupInterpolationEmitTests {
    @Fact
    func OahuCoreImportedExtensionMethodGroup_Interpolation_InfersFuncAndRuns() {
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue2731NaturalMethodGroupInterpolationEmitTests")
        Directory.CreateDirectory(directory)
        let libraryPath = EmitOahuCoreLibrary(directory)
        let consumerPath = Path.Combine(directory, "Issue2731.Consumer.dll")
        const source = `package Issue2731
import Oahu.Core

func SourceChecksum() uint32 -> 42u

data class Profile(AccountName string?) {
    func Render() string ->
        "imported=${AccountName!!.Checksum32}; source=${SourceChecksum}"
}

func Run() string -> Profile("account").Render()`
        {
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            using let output = File.Create(consumerPath)
            let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2731.Consumer")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        let loadContext = AssemblyLoadContext("Issue2731", isCollectible: true)
        try {
            let _ = loadContext.LoadFromAssemblyPath(libraryPath)
            let consumer = loadContext.LoadFromAssemblyPath(consumerPath)
            let run MethodInfo? = consumer
                .GetTypes()
                .Single((type Type) -> type.Name == "<Program>")
                .GetMethod("Run", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            Assert.NotNull(run)
            Assert.Equal(
                "imported=System.Func`1[System.UInt32]; source=System.Func`1[System.UInt32]",
                run!!.Invoke(nil, nil)
            )
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func EmitOahuCoreLibrary(directory string) string {
            const source = `namespace Oahu.Core;

public static class ChecksumExtensions
{
    public static uint Checksum32(this string value) => (uint)value.Length;
}`
            let libraryPath = Path.Combine(directory, "Oahu.Core.dll")
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Oahu.Core",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let output = File.Create(libraryPath)
            let result = compilation.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }
    }
}
