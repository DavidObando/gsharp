// <copyright file="Issue2888InterfacePropertyTypeMismatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2888: ordinary properties must match their G# interface property's
/// type after generic substitution and nullability variance.
/// </summary>
public class Issue2888InterfacePropertyTypeMismatchTests
{
    [Fact]
    public void OrdinaryTypeMismatches_ReportGS0187AndDoNotEmit()
    {
        const string source = """
            package Rejected

            interface IClassGet { prop Value int32 { get; } }
            class ClassGet : IClassGet { prop Value string { get; } }

            interface IStructGet { prop Value int32 { get; } }
            struct StructGet : IStructGet { prop Value string { get; } }

            interface IClassGetSet { prop Value int32 { get; set; } }
            class ClassGetSet : IClassGetSet { prop Value string { get; set; } }

            interface IStructGetSet { prop Value int32 { get; set; } }
            struct StructGetSet : IStructGetSet { prop Value string { get; set; } }

            interface INonNullableGet { prop Value string { get; } }
            class NullableGet : INonNullableGet { prop Value string? -> nil }

            interface INullableSet { prop Value string? { get; set; } }
            class NonNullableSet : INullableSet { prop Value string { get; set; } }

            interface INonNullableSet { prop Value string { get; set; } }
            class NullableSet : INonNullableSet { prop Value string? { get; set; } }

            interface IGeneric[T] { prop Value T { get; } }
            class GenericMismatch : IGeneric[int32] { prop Value string -> "x" }

            class Cell[T] { }
            interface IConstructed { prop Value Cell[int32] { get; } }
            class ConstructedMismatch : IConstructed {
                prop Value Cell[string] -> Cell[string]()
            }

            interface IBase { prop Value int32 { get; } }
            interface IDerived : IBase { }
            class BaseInterfaceMismatch : IDerived { prop Value string -> "x" }

            open class PropertyBase { prop Value string -> "x" }
            interface IInheritedProperty { prop Value int32 { get; } }
            class InheritedPropertyMismatch : PropertyBase, IInheritedProperty { }

            interface IInit { prop Value int32 { get; init; } }
            class InitMismatch : IInit { prop Value string { get; init; } }

            interface IIndexer { prop this[key string] int32 { get; } }
            class IndexerMismatch : IIndexer {
                prop this[key string] string { get { return "x" } }
            }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Equal(13, CountOccurrences(output, "error GS0187:"));
        Assert.DoesNotContain("GS0502", output, StringComparison.Ordinal);
        foreach (var typeName in new[]
        {
            "ClassGet",
            "StructGet",
            "ClassGetSet",
            "StructGetSet",
            "NullableGet",
            "NonNullableSet",
            "NullableSet",
            "GenericMismatch",
            "ConstructedMismatch",
            "BaseInterfaceMismatch",
            "InheritedPropertyMismatch",
            "InitMismatch",
            "IndexerMismatch",
        })
        {
            Assert.Contains($"Class '{typeName}' does not implement interface method", output, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void CompatibleSiblingShapes_EmitVerifyAndLoad()
    {
        const string source = """
            package Accepted

            interface IClassGet { prop Value int32 { get; } }
            class ClassGet : IClassGet { prop Value int32 { get; } }

            interface IStructGetSet { prop Value int32 { get; set; } }
            struct StructGetSet : IStructGetSet { prop Value int32 { get; set; } }

            interface INullableClassGet { prop Value string? { get; } }
            class NonNullableClassGet : INullableClassGet { prop Value string -> "x" }

            interface INullableSet { prop Value string? { get; set; } }
            class NullableSet : INullableSet { prop Value string? { get; set; } }

            interface IGeneric[T] { prop Value T { get; } }
            class GenericExact : IGeneric[int32] { prop Value int32 -> 1 }

            interface IGenericNullable[T] { prop Value T? { get; } }
            class GenericCovariant : IGenericNullable[string] { prop Value string -> "x" }

            class Cell[T] { }
            interface IConstructed { prop Value Cell[int32] { get; } }
            class ConstructedExact : IConstructed {
                prop Value Cell[int32] -> Cell[int32]()
            }

            interface IBase { prop Value int32 { get; } }
            interface IDerived : IBase { }
            class BaseInterfaceExact : IDerived { prop Value int32 -> 1 }

            open class PropertyBase { prop Value int32 -> 1 }
            interface IInheritedProperty { prop Value int32 { get; } }
            class InheritedPropertyExact : PropertyBase, IInheritedProperty { }

            interface IInit { prop Value int32 { get; init; } }
            class InitExact : IInit { prop Value int32 { get; init; } }

            interface IExplicit { prop Value int32 { get; } }
            class ExplicitExact : IExplicit {
                private prop (IExplicit) Value int32 -> 1
            }

            interface IExplicitIndexer { prop this[key string] int32 { get; } }
            class ExplicitIndexerExact : IExplicitIndexer {
                private prop (IExplicitIndexer) this[key string] int32 {
                    get { return 1 }
                }
            }

            sealed interface IStatic[T] {
                shared { prop Value T { get; } }
            }
            struct StaticExact : IStatic[int32] {
                shared { prop Value int32 -> 1 }
            }

            interface IPositionalClass { prop Value int32 { get; } }
            data class PositionalClass(Value int32) : IPositionalClass

            interface IPositionalStruct { prop Value int32 { get; } }
            data struct PositionalStruct(Value int32) : IPositionalStruct

            interface IDefault {
                prop Value int32 { get { return 1 } }
            }
            class DefaultWithUnrelatedProperty : IDefault {
                prop Value string -> "x"
            }
            """;

        AssertEmitsAndLoads(source);
    }

    [Fact]
    public void ExplicitAndStaticMismatchPaths_StillRejectWithoutOutput()
    {
        const string source = """
            package ExistingPaths

            interface IExplicit { prop Value int32 { get; } }
            class ExplicitMismatch : IExplicit {
                private prop (IExplicit) Value string -> "x"
            }

            sealed interface IStatic {
                shared { prop Value int32 { get; } }
            }
            struct StaticMismatch : IStatic {
                shared { prop Value string -> "x" }
            }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains("GS0494", output, StringComparison.Ordinal);
        Assert.Contains("GS0397", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedClrInterfaceProperty_ExactType_EmitsVerifyAndLoads()
    {
        const string source = """
            package ImportedExact
            import ClrContracts

            class Box : IBox {
                prop Value int32 { get; set; }
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var referencePath = CompileCSharpFixture(directory);
            AssertEmitsAndLoads(source, referencePath);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedClrInterfaceProperty_WrongType_ReportsGS0187AndDoesNotEmit()
    {
        const string source = """
            package ImportedMismatch
            import ClrContracts

            class Box : IBox {
                prop Value string { get; set; }
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var referencePath = CompileCSharpFixture(directory);
            var output = CompileExpectingFailure(source, referencePath);
            Assert.Contains("GS0187", output, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static int CountOccurrences(string text, string value)
        => text.Split(value, StringSplitOptions.None).Length - 1;

    private static string CompileExpectingFailure(string source, string referencePath = null)
    {
        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = CreateCompilerArguments(sourcePath, outputPath, referencePath);
            var (exitCode, output) = Compile(arguments);

            Assert.NotEqual(0, exitCode);
            Assert.False(File.Exists(outputPath), "gsc must not emit an assembly after an interface-property error.");
            return output;
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void AssertEmitsAndLoads(string source, string referencePath = null)
    {
        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = CreateCompilerArguments(sourcePath, outputPath, referencePath);
            var (exitCode, output) = Compile(arguments);

            Assert.True(exitCode == 0, "gsc failed:\n" + output);
            Assert.True(File.Exists(outputPath), "gsc did not emit the expected assembly.");
            IlVerifier.Verify(
                outputPath,
                referencePath == null ? null : new[] { referencePath });
            if (referencePath != null)
            {
                _ = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.GetFullPath(referencePath));
            }

            _ = Assembly.Load(File.ReadAllBytes(outputPath)).GetTypes();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string[] CreateCompilerArguments(
        string sourcePath,
        string outputPath,
        string referencePath)
    {
        var arguments = new List<string>
        {
            "/out:" + outputPath,
            "/target:library",
            "/targetframework:net10.0",
        };
        if (referencePath != null)
        {
            arguments.Add("/r:" + referencePath);
        }

        arguments.Add(sourcePath);
        return arguments.ToArray();
    }

    private static string CompileCSharpFixture(string directory)
    {
        var outputPath = Path.Combine(directory, "ClrContracts." + Guid.NewGuid().ToString("N") + ".dll");
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            .Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            Path.GetFileNameWithoutExtension(outputPath),
            new[]
            {
                CSharpSyntaxTree.ParseText(
                    """
                    namespace ClrContracts;
                    public interface IBox
                    {
                        int Value { get; set; }
                    }
                    """,
                    new CSharpParseOptions(LanguageVersion.Latest)),
            },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var output = File.Create(outputPath);
        var result = compilation.Emit(output);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static (int ExitCode, string Output) Compile(params string[] arguments)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(arguments);
            return (exitCode, stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string CreateWorkDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2888",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
