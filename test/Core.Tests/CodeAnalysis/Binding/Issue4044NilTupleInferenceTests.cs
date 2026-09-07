// <copyright file="Issue4044NilTupleInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;
using CSharpCompilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation;
using CSharpCompilationOptions = Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions;
using CSharpParseOptions = Microsoft.CodeAnalysis.CSharp.CSharpParseOptions;
using CSharpSyntaxTree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree;
using LanguageVersion = Microsoft.CodeAnalysis.CSharp.LanguageVersion;
using MetadataReference = Microsoft.CodeAnalysis.MetadataReference;
using OutputKind = Microsoft.CodeAnalysis.OutputKind;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #4044: a nil tuple element stays open during generic inference.</summary>
public class Issue4044NilTupleInferenceTests
{
    private static readonly string ImportedLibraryPath = EmitCSharpLibrary();

    [Fact]
    public void NilTupleElement_DoesNotFixWholeGenericArgument()
    {
        const string source = """
            package P
            class Asserts {
                shared {
                    func Equal[T](expected T, actual T) { }
                }
            }
            func Receive2() (string?, bool) -> (nil, false)
            func Run() {
                Asserts.Equal((nil, false), Receive2())
            }
            """;

        Assert.DoesNotContain(Compile(source), diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void FullyTypedTuple_StillContributesToGenericInference()
    {
        const string source = """
            package P
            class Asserts {
                shared {
                    func Equal[T](expected T, actual T) { }
                }
            }
            func Receive2() (string?, bool) -> (nil, false)
            func Run() {
                Asserts.Equal(("expected", false), Receive2())
            }
            """;

        Assert.DoesNotContain(Compile(source), diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ImportedGeneric_NilTupleElement_UsesOtherArgumentTarget()
    {
        const string source = """
            package P
            import Xunit
            func Receive2() (string?, bool) -> (nil, false)
            func Run() {
                Assert.Equal((nil, false), Receive2())
            }
            """;

        Assert.DoesNotContain(
            CompileWithReferences(source, typeof(Assert).Assembly.Location),
            diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ImportedGeneric_NilTupleElement_DoesNotTargetValueType()
    {
        const string source = """
            package P
            import Xunit
            func Actual() (int32, bool) -> (1, false)
            func Run() {
                Assert.Equal((nil, false), Actual())
            }
            """;

        Assert.Contains(
            CompileWithReferences(source, typeof(Assert).Assembly.Location),
            diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ImportedExtension_NilTupleElement_SurvivesReceiverInference()
    {
        const string source = """
            package P
            import System.Collections.Generic
            import Lib4044
            func Run() {
                let values = List[(string?, bool)]()
                values.Add(("x", false))
                let found = values.Includes((nil, false))
            }
            """;

        Assert.DoesNotContain(
            CompileWithReferences(source, ImportedLibraryPath),
            diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ImportedParamsGeneric_NilTupleElement_UsesSiblingArgument()
    {
        const string source = """
            package P
            import Lib4044
            func Run() {
                let found = Extensions.AnyEqual((nil, false), ("x", false))
            }
            """;

        Assert.DoesNotContain(
            CompileWithReferences(source, ImportedLibraryPath),
            diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ImportedParamsGeneric_NilTupleElement_PreservesOtherElementInference()
    {
        const string source = """
            package P
            import Lib4044
            func Run() {
                let found = Extensions.AnyPair("x", (nil, 1))
            }
            """;

        Assert.DoesNotContain(
            CompileWithReferences(source, ImportedLibraryPath),
            diagnostic => diagnostic.IsError);
    }

    private static System.Collections.Immutable.ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Compile(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };
        return EmittedOracle.CompileDiagnostics(compilation);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> CompileWithReferences(
        string source,
        params string[] additionalReferences)
    {
        var runtimeDirectory = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        var references = ReferenceResolver.WithReferences(
            Directory.GetFiles(runtimeDirectory, "*.dll").Concat(additionalReferences));
        var compilation = new Compilation(
            references,
            SyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };

        return compilation.BoundProgram.Diagnostics;
    }

    private static string EmitCSharpLibrary()
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue4044Binding");
        Directory.CreateDirectory(outputDirectory);
        var libraryPath = Path.Combine(outputDirectory, "Lib4044.dll");

        const string source = """
            using System.Collections.Generic;

            namespace Lib4044
            {
                public static class Extensions
                {
                    public static bool Includes<T>(this List<T> values, T value)
                        => values.Contains(value);

                    public static bool AnyEqual<T>(params T[] values)
                        => values.Length > 1;

                    public static bool AnyPair<T, U>(T seed, params (T, U)[] values)
                        => values.Length > 0;
                }
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest));
        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();
        var references = referencePaths
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Lib4044",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(libraryPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
