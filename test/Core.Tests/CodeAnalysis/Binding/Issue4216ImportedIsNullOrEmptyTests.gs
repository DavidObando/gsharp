// <copyright file="Issue4216ImportedIsNullOrEmptyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import ReferenceResolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver
import SourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic

/// Issue #4216: the `IsNullOrEmpty` compatibility rule must behave the
/// same for an extension imported from a REFERENCED assembly as it does for a
/// source-declared one. The in-source tests cannot cover this: imported
/// methods reach the classifier as `BoundImportedCallExpression` with
/// (cref:System.Reflection.ParameterInfo) metadata rather than
/// `ParameterSymbol`s, so the two arms are entirely separate code paths.
open class Issue4216ImportedIsNullOrEmptyTests : IDisposable {
    private let directory string = CreateOutputDirectory()

    @Fact
    func ImportedUnannotatedExtension_NarrowsReceiver() {
        let library = EmitCSharpLibrary(`#nullable enable
using System.Collections.Generic;

namespace Issue4216.PredicateLibrary;

public static class SequenceExtensions
{
    public static bool IsNullOrEmpty(this IEnumerable<int>? values)
        => values == null || !values.GetEnumerator().MoveNext();
}`)
        let diagnostics = CompileGSharp(`package Issue4216.Consumer
import System.Collections.Generic
import Issue4216.PredicateLibrary

func Count(values IEnumerable[int32]?) int32 {
    var count = 0
    if !values.IsNullOrEmpty() {
        for value in values {
            count++
        }
    }
    return count
}`, library)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ImportedExtensionWithExplicitContract_OverridesTheNameRule() {
        // [NotNullWhen(true)] in the referenced assembly's metadata must win
        // over the compatibility rule's implied [NotNullWhen(false)].
        let library = EmitCSharpLibrary(`#nullable enable
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;

namespace Issue4216.PredicateLibrary;

public static class SequenceExtensions
{
    public static bool IsNullOrEmpty([NotNullWhen(true)] this IEnumerable<int>? values)
        => values != null;
}`)
        let diagnostics = CompileGSharp(`package Issue4216.Consumer
import System.Collections.Generic
import Issue4216.PredicateLibrary

func Count(values IEnumerable[int32]?) int32 {
    var count = 0
    if values.IsNullOrEmpty() {
        for value in values {
            count++
        }
    }
    return count
}`, library)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ImportedNonNullableReceiver_DoesNotNarrowNullableArgument() {
        // The declared receiver is non-nullable `IEnumerable<int>`, so the
        // compatibility rule must not attach a contract to it.
        let library = EmitCSharpLibrary(`#nullable enable
using System.Collections.Generic;

namespace Issue4216.PredicateLibrary;

public static class SequenceExtensions
{
    public static bool IsNullOrEmpty(this IEnumerable<int> values)
        => !values.GetEnumerator().MoveNext();
}`)
        let diagnostics = CompileGSharp(`package Issue4216.Consumer
import System.Collections.Generic
import Issue4216.PredicateLibrary

func Count(values IEnumerable[int32]?) int32 {
    var count = 0
    if !values!!.IsNullOrEmpty() {
        for value in values {
            count++
        }
    }
    return count
}`, library)
        Assert.Contains(
            diagnostics,
            (diagnostic string) -> diagnostic.Contains("IEnumerable[int32]?", StringComparison.Ordinal)
        )
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        GC.SuppressFinalize(this)
        try {
            Directory.Delete(this.directory, recursive: true)
        } catch (IOException) { }
    }

    private func EmitCSharpLibrary(source string) string {
        let references = (
            (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                Array.Empty[string]()
        )
            .Where(File.Exists).Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
        let compilation = CSharpCompilation.Create(
            LibraryAssemblyName,
            []Microsoft
                .CodeAnalysis
                .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let path = Path.Combine(this.directory, LibraryAssemblyName + ".dll")
        using let output = File.Create(path)
        let emit = compilation.Emit(output)
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        return path
    }

    private func CompileGSharp(source string, library string)[]string {
        let runtime = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        let references = Directory
            .EnumerateFiles(runtime, "*.dll", SearchOption.TopDirectoryOnly)
            .Append(library)
            .ToArray()
        using let resolver = ReferenceResolver.WithReferences(references)
        resolver.CurrentAssemblyName = ConsumerAssemblyName
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
            AssemblyName = ConsumerAssemblyName
        }
        return compilation
            .SyntaxTrees
            .SelectMany(
            func (tree GSharp.Core.CodeAnalysis.Syntax.SyntaxTree) IEnumerable[GSharp.Core.CodeAnalysis.Diagnostic] {
                return tree.Diagnostics
            }
        )
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Select((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Message)
            .ToArray()
    }

    shared {
        private const LibraryAssemblyName string = "Issue4216.PredicateLibrary"
        private const ConsumerAssemblyName string = "Issue4216.Consumer"

        private func CreateOutputDirectory() string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4216ImportedIsNullOrEmptyTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }
    }
}
