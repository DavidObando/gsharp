// <copyright file="CSharpFixture.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Compiles an imported C# contract without migrating its metadata premises.
internal class CSharpFixture : IDisposable {
    internal init(
        source string,
        additionalReferences IEnumerable[MetadataReference]? = nil,
        parseOptions CSharpParseOptions? = nil,
        assemblyName string? = nil,
        allowUnsafe bool = false
    ) {
        DirectoryPath = Path.Combine(AppContext.BaseDirectory, "csharp-fixtures", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(DirectoryPath)
        AssemblyPath = Path.Combine(
            DirectoryPath,
            (assemblyName ?? ("CSharpContract" + Guid.NewGuid().ToString("N"))) + ".dll"
        )
        try {
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(AssemblyPath),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, parseOptions)},
                ReferenceResolver
                    .HostTrustedPlatformAssemblyPaths()
                    .Select((path string) -> MetadataReference.CreateFromFile(path))
                    .Concat(additionalReferences ?? Array.Empty[MetadataReference]()),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: allowUnsafe)
            )
            using let stream = File.Create(AssemblyPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        } catch {
            Directory.Delete(DirectoryPath, recursive: true)
            rethrow
        }
    }

    internal prop DirectoryPath string {
        get;
    }

    internal prop AssemblyPath string {
        get;
    }

    internal func Load() Assembly -> EmittedFixture.Load(File.ReadAllBytes(AssemblyPath), DirectoryPath)

    internal func LoadTogether(images ...[][]uint8)[]Assembly -> EmittedFixture.LoadTogether(DirectoryPath, images)

    internal func RuntimeReferences() ReferenceResolver -> ReferenceResolver.WithRuntimeReferences(
        []string{AssemblyPath}
    )

    func Dispose() -> Directory.Delete(DirectoryPath, recursive: true)
}
