// <copyright file="Issue2585SemanticQualificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2585SemanticQualificationTests
{
    private static readonly string LibraryPath = EmitLibrary();

    [Fact]
    public void ImportedNamespaceHomonym_DoesNotReclassifyEventLambdaParameterAsTypeRoot()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Oahu.App
            import Oahu.Tui

            func Wire(hub Hub) {
                hub.Changed += (vm ViewModel) -> {
                    vm.Changed += () -> { }
                }
            }
            """));
    }

    [Fact]
    public void ImportedNamespaceHomonym_DoesNotReclassifyLocalValueAsTypeRoot()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Oahu.App
            import Oahu.Tui

            func Run() {
                let vm = ViewModel()
                vm.Changed += () -> { }
            }
            """));
    }

    [Fact]
    public void ImportedConstructorPath_DoesNotReclassifyLocalValueAsNamespaceRoot()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Oahu.App
            import Oahu.Trap

            func Run() int32 {
                let local = Factory()
                return local.Make()
            }
            """));
    }

    [Fact]
    public void ImportedNestedNamespaceAndAlias_RemainValidTypeQualifiers()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Tui = Oahu.Tui

            func Run() {
                let direct = Oahu.Tui.Nested.Refresh()
                let aliased = Tui.Nested.Refresh()
            }
            """));
    }

    [Fact]
    public void FullyQualifiedImportedStaticMember_SelectsTypeDespiteSourceHomonym()
    {
        Assert.Empty(Bind(
            """
            package Oahu.Core.Ex

            class JsonExtensions {
            }
            """,
            """
            package Oahu.Audible.Json
            import Oahu.Aux.Extensions

            func Read() int32 {
                return Oahu.Aux.Extensions.JsonExtensions.Options
            }
            """));
    }

    [Fact]
    public void FullyQualifiedSourceStaticMember_SelectsMatchingPackage()
    {
        Assert.Empty(Bind(
            """
            package Target

            class JsonExtensions {
                shared {
                    let Options int32 = 1
                }
            }
            """,
            """
            package Other

            class JsonExtensions {
            }
            """,
            """
            package Consumer

            func Read() int32 {
                return Target.JsonExtensions.Options
            }
            """));
    }

    [Fact]
    public void FullyQualifiedImportedStaticMember_UnknownMemberRemainsDiagnosed()
    {
        Assert.Contains(
            Bind(
                """
                package Oahu.Core.Ex

                class JsonExtensions {
                }
                """,
                """
                package Consumer
                import Oahu.Aux.Extensions

                func Read() int32 {
                    return Oahu.Aux.Extensions.JsonExtensions.Missing
                }
                """),
            diagnostic => diagnostic.Id == "GS0158");
    }

    [Fact]
    public void ImportedGenericCompositeLiteral_ResolvesClosedType()
    {
        Assert.Empty(Bind("""
            package Consumer
            import Oahu.Widgets

            func Run() {
                let list = SelectList[string]{ Value: "ok" }
            }
            """));
    }

    [Fact]
    public void ImportedGenericCompositeLiteral_WrongArity_RemainsDiagnosed()
    {
        Assert.Contains(
            Bind("""
                package Consumer
                import Oahu.Widgets

                func Run() {
                    SelectList[string, int32]{ Value: "bad" }
                }
                """),
            diagnostic => diagnostic.Message.Contains("Cannot find type SelectList", StringComparison.Ordinal));
    }

    [Fact]
    public void SourceQualifiedTypeAndValueReceiver_RemainDistinct()
    {
        Assert.Empty(Bind(
            """
            package Oahu.App

            class ViewModel {
                event Changed () -> void

                func Refresh() {
                }
            }
            """,
            """
            package Oahu.Tui.Nested

            class Refresh {
                init(required int32) {
                }
            }

            class vm {
            }
            """,
            """
            package Consumer
            import AppAlias = Oahu.App

            func Run() {
                let vm = Oahu.App.ViewModel()
                vm.Changed += () -> { }
                vm.Refresh()
                let aliased = AppAlias.ViewModel()
                aliased.Refresh()
                let qualified = Oahu.Tui.Nested.Refresh(1)
            }
            """));
    }

    private static System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Bind(params string[] sources)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { LibraryPath });
        var trees = sources
            .Select(source => GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source)))
            .ToArray();
        var compilation = new GsCompilation(resolver, trees) { IsLibrary = true };
        return trees.SelectMany(tree => tree.Diagnostics)
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
    }

    private static string EmitLibrary()
    {
        string outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue2585Binding");
        Directory.CreateDirectory(outputDirectory);
        string libraryPath = Path.Combine(outputDirectory, "Issue2585.Library.dll");

        const string source = """
            using System;

            namespace Oahu.App
            {
                public sealed class ViewModel
                {
                    public event Action Changed;
                    public void Refresh() { }
                }

                public sealed class Hub
                {
                    public event Action<ViewModel> Changed;
                }

                public sealed class Factory
                {
                    public int Make() => 1;
                }
            }

            namespace Oahu.Tui.Nested
            {
                public sealed class Refresh
                {
                    public Refresh() { }
                }
            }

            namespace Oahu.Tui
            {
                public sealed class vm
                {
                }
            }

            namespace Oahu.Trap.local
            {
                public sealed class Make
                {
                }
            }

            namespace Oahu.Widgets
            {
                public sealed class SelectList<T>
                {
                    public T Value { get; set; }
                }
            }

            namespace Oahu.Aux.Extensions
            {
                public static class JsonExtensions
                {
                    public static int Options => 1;
                }
            }
            """;

        var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest));
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            .Split(Path.PathSeparator)
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue2585.Library",
            new[] { tree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(libraryPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
