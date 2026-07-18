// <copyright file="Issue2395FileScopedImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2395: imports belong to the syntax tree that declares them.
/// </summary>
public class Issue2395FileScopedImportTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ClrNamespaceImport_IsVisibleOnlyInDeclaringFile_ForSignaturesAndBodies(bool importingFileFirst)
    {
        const string importing = """
            package Demo
            import System.Text

            class ImportedUser {
                func Make(value StringBuilder) StringBuilder {
                    return StringBuilder(value.ToString())
                }
            }
            """;
        const string unrelated = """
            package Demo

            class UnrelatedUser {
                func Make(value StringBuilder) StringBuilder {
                    return StringBuilder(value.ToString())
                }
            }
            """;

        var errors = Errors(Order(importingFileFirst, importing, unrelated)).ToArray();

        Assert.DoesNotContain(errors, d => d.Location.FileName == "importing.gs");
        Assert.Contains(errors, d => d.Location.FileName == "unrelated.gs");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void StaticTypeImport_AndClrAlias_DoNotLeakToSiblingFile(bool importingFileFirst)
    {
        const string library = """
            package Library

            class MathUtil {
                shared {
                    func Twice(value int32) int32 { return value * 2 }
                }
            }
            """;
        const string importing = """
            package Demo
            import Library.MathUtil
            import io = System.IO

            class ImportedUser {
                func Calculate() int32 { return Twice(16) }
                func Current() string { return io.Directory.GetCurrentDirectory() }
            }
            """;
        const string unrelated = """
            package Demo

            class UnrelatedUser {
                func Calculate() int32 { return Twice(16) }
                func Current() string { return io.Directory.GetCurrentDirectory() }
            }
            """;

        var ordered = importingFileFirst
            ? new[] { ("library.gs", library), ("importing.gs", importing), ("unrelated.gs", unrelated) }
            : new[] { ("unrelated.gs", unrelated), ("importing.gs", importing), ("library.gs", library) };
        var errors = Errors(ordered).ToArray();

        Assert.DoesNotContain(errors, d => d.Location.FileName == "importing.gs");
        Assert.Contains(errors, d => d.Location.FileName == "unrelated.gs");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ClrExtensionNamespaceImport_DoesNotLeakToSiblingFile(bool importingFileFirst)
    {
        const string importing = """
            package Demo
            import System.Linq

            class ImportedUser {
                func Convert(values []int32) object { return values.ToHashSet() }
            }
            """;
        const string unrelated = """
            package Demo

            class UnrelatedUser {
                func Convert(values []int32) object { return values.ToHashSet() }
            }
            """;

        var errors = Errors(Order(importingFileFirst, importing, unrelated)).ToArray();

        Assert.DoesNotContain(errors, d => d.Location.FileName == "importing.gs");
        Assert.Contains(errors, d => d.Location.FileName == "unrelated.gs");
    }

    [Fact]
    public void SamePackageDeclarationsRemainVisibleAcrossFiles_AndForeignTypeCanBeQualified()
    {
        const string declarations = """
            package Demo

            class Shared {}
            func MakeShared() Shared { return Shared{} }
            """;
        const string consumer = """
            package Demo

            class Consumer {
                func Use(value Shared) Shared { return MakeShared() }
            }
            """;
        const string foreign = """
            package Foreign

            class External {}
            """;
        const string qualified = """
            package Demo

            class Qualified {
                func Make() object { return Foreign.External{} }
            }
            """;

        Assert.Empty(Errors(new[]
        {
            ("declarations.gs", declarations),
            ("consumer.gs", consumer),
            ("foreign.gs", foreign),
            ("qualified.gs", qualified),
        }));
    }

    [Fact]
    public void UnrelatedFileImport_CannotDisambiguateCollidingSimpleName()
    {
        const string left = "package Left\nclass Result {}\n";
        const string right = "package Right\nclass Result {}\n";
        const string unrelated = "package Other\nimport Left\nclass Marker {}\n";
        const string consumer = """
            package Consumer

            class UsesResult {
                prop Value Result
            }
            """;

        var errors = Errors(new[]
        {
            ("left.gs", left),
            ("right.gs", right),
            ("unrelated.gs", unrelated),
            ("consumer.gs", consumer),
        }).ToArray();

        Assert.DoesNotContain(errors, d => d.Id == "GS0496");
    }

    [Fact]
    public void SameFileCollidingImports_ReportAmbiguityAtReferencingFile()
    {
        const string left = "package Left\nclass Result {}\n";
        const string right = "package Right\nclass Result {}\n";
        const string consumer = """
            package Consumer
            import Left
            import Right

            class UsesResult {
                prop Value Result
            }
            """;

        var errors = Errors(new[]
        {
            ("right.gs", right),
            ("consumer.gs", consumer),
            ("left.gs", left),
        }).ToArray();

        Assert.Contains(errors, d => d.Id == "GS0496" && d.Location.FileName == "consumer.gs");
    }

    [Fact]
    public async Task ConcurrentReferencingTrees_DoNotShareAmbientImportContext()
    {
        var leftTree = SyntaxTree.Parse(SourceText.From("import System.Text\n", "left.gs"));
        var rightTree = SyntaxTree.Parse(SourceText.From("import System.IO\n", "right.gs"));
        var leftImport = leftTree.Root.Members.OfType<ImportSyntax>().Single();
        var rightImport = rightTree.Root.Members.OfType<ImportSyntax>().Single();
        var scope = new BoundScope(parent: null);
        scope.TryImport(new ImportSymbol("System.Text", "System.Text", leftImport));
        scope.TryImport(new ImportSymbol("System.IO", "System.IO", rightImport));
        using var ready = new CountdownEvent(2);

        async Task<ImmutableArray<string>> VisibleImports(SyntaxTree tree)
        {
            var previous = scope.SetCurrentReferencingSyntaxTree(tree);
            try
            {
                ready.Signal();
                await Task.Run(() => ready.Wait());
                return scope.GetDeclaredImports().Select(i => i.Target).ToImmutableArray();
            }
            finally
            {
                scope.SetCurrentReferencingSyntaxTree(previous);
            }
        }

        var results = await Task.WhenAll(VisibleImports(leftTree), VisibleImports(rightTree));

        Assert.Equal(new[] { "System.Text" }, results[0]);
        Assert.Equal(new[] { "System.IO" }, results[1]);
    }

    private static (string FileName, string Source)[] Order(bool first, string importing, string unrelated)
        => first
            ? new[] { ("importing.gs", importing), ("unrelated.gs", unrelated) }
            : new[] { ("unrelated.gs", unrelated), ("importing.gs", importing) };

    private static IEnumerable<Diagnostic> Errors(IEnumerable<(string FileName, string Source)> sources)
    {
        var trees = sources
            .Select(source => SyntaxTree.Parse(SourceText.From(source.Source, source.FileName)))
            .ToArray();
        var compilation = new Compilation(trees) { IsLibrary = true };
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError);
    }
}
