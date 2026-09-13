// <copyright file="Issue4216ImportedIsNullOrEmptyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using ReferenceResolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver;
using SourceText = GSharp.Core.CodeAnalysis.Text.SourceText;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4216: the <c>IsNullOrEmpty</c> compatibility rule must behave the
/// same for an extension imported from a REFERENCED assembly as it does for a
/// source-declared one. The in-source tests cannot cover this: imported
/// methods reach the classifier as <c>BoundImportedCallExpression</c> with
/// <see cref="System.Reflection.ParameterInfo"/> metadata rather than
/// <c>ParameterSymbol</c>s, so the two arms are entirely separate code paths.
/// </summary>
public class Issue4216ImportedIsNullOrEmptyTests : IDisposable
{
    private const string LibraryAssemblyName = "Issue4216.PredicateLibrary";
    private const string ConsumerAssemblyName = "Issue4216.Consumer";

    private readonly string directory = CreateOutputDirectory();

    [Fact]
    public void ImportedUnannotatedExtension_NarrowsReceiver()
    {
        var library = EmitCSharpLibrary("""
            #nullable enable
            using System.Collections.Generic;

            namespace Issue4216.PredicateLibrary;

            public static class SequenceExtensions
            {
                public static bool IsNullOrEmpty(this IEnumerable<int>? values)
                    => values == null || !values.GetEnumerator().MoveNext();
            }
            """);

        var diagnostics = CompileGSharp("""
            package Issue4216.Consumer
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
            }
            """, library);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ImportedExtensionWithExplicitContract_OverridesTheNameRule()
    {
        // [NotNullWhen(true)] in the referenced assembly's metadata must win
        // over the compatibility rule's implied [NotNullWhen(false)].
        var library = EmitCSharpLibrary("""
            #nullable enable
            using System.Collections.Generic;
            using System.Diagnostics.CodeAnalysis;

            namespace Issue4216.PredicateLibrary;

            public static class SequenceExtensions
            {
                public static bool IsNullOrEmpty([NotNullWhen(true)] this IEnumerable<int>? values)
                    => values != null;
            }
            """);

        var diagnostics = CompileGSharp("""
            package Issue4216.Consumer
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
            }
            """, library);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ImportedNonNullableReceiver_DoesNotNarrowNullableArgument()
    {
        // The declared receiver is non-nullable `IEnumerable<int>`, so the
        // compatibility rule must not attach a contract to it.
        var library = EmitCSharpLibrary("""
            #nullable enable
            using System.Collections.Generic;

            namespace Issue4216.PredicateLibrary;

            public static class SequenceExtensions
            {
                public static bool IsNullOrEmpty(this IEnumerable<int> values)
                    => !values.GetEnumerator().MoveNext();
            }
            """);

        var diagnostics = CompileGSharp("""
            package Issue4216.Consumer
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
            }
            """, library);

        Assert.Contains(
            diagnostics,
            diagnostic => diagnostic.Contains("IEnumerable[int32]?", StringComparison.Ordinal));
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        GC.SuppressFinalize(this);
        try
        {
            Directory.Delete(this.directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private static string CreateOutputDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4216ImportedIsNullOrEmptyTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private string EmitCSharpLibrary(string source)
    {
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            LibraryAssemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(this.directory, LibraryAssemblyName + ".dll");
        using var output = File.Create(path);
        var emit = compilation.Emit(output);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return path;
    }

    private string[] CompileGSharp(string source, string library)
    {
        var runtime = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var references = Directory
            .EnumerateFiles(runtime, "*.dll", SearchOption.TopDirectoryOnly)
            .Append(library)
            .ToArray();

        using var resolver = ReferenceResolver.WithReferences(references);
        resolver.CurrentAssemblyName = ConsumerAssemblyName;
        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(source)))
        {
            AssemblyName = ConsumerAssemblyName,
        };

        return compilation.SyntaxTrees.SelectMany(tree => tree.Diagnostics)
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Select(diagnostic => diagnostic.Message)
            .ToArray();
    }
}
