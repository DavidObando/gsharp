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
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Threading
import Xunit

/// Compiles an imported C# contract without migrating its metadata premises.
internal class CSharpFixture : IDisposable {
    internal init(
        source string,
        additionalReferences IEnumerable[MetadataReference]? = nil,
        parseOptions CSharpParseOptions? = nil,
        assemblyName string? = nil,
        allowUnsafe bool = false,
        deterministic bool = false
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
                HostReferences.Concat(additionalReferences ?? Array.Empty[MetadataReference]()),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    allowUnsafe: allowUnsafe,
                    deterministic: deterministic
                )
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

    shared {
        private let CachedHostReferences Lazy[ImmutableArray[MetadataReference]] = Lazy[
            ImmutableArray[MetadataReference]
        ](
            () -> ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .ToImmutableArray(),
            LazyThreadSafetyMode.ExecutionAndPublication
        )

        internal prop HostReferences ImmutableArray[MetadataReference] -> CachedHostReferences.Value
    }
}
