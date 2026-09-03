// <copyright file="Issue2875DataClassSettableInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2875: an init-only positional data member cannot implement an
/// interface property that requires an ordinary setter.
/// </summary>
public class Issue2875DataClassSettableInterfaceTests
{
    [Fact]
    public void PositionalDataClassMember_SettableInterfaceProperty_ReportsGS0502AndDoesNotEmit()
    {
        const string source = """
            package S1

            interface IBox {
                prop Value int32 { get; set; }
            }

            data class Box(Value int32) : IBox
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains("GS0502", output, StringComparison.Ordinal);
        Assert.Contains(
            "Type 'Box' cannot use positional member 'Value' to implement interface property 'IBox.Value' because the member uses accessor 'init' but the interface requires 'set'; declare property 'Value' explicitly with a 'set' accessor.",
            output,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitSettableProperty_StillVerifiesAndRuns()
    {
        const string source = """
            package S2
            import System

            interface IBox2 {
                prop Value int32 { get; set; }
            }

            data class Box2 : IBox2 {
                prop Value int32 { get; set; }
            }

            func Main() {
                let box IBox2 = Box2()
                box.Value = 7
                Console.WriteLine(box.Value)
            }
            """;

        Assert.Equal($"7{Environment.NewLine}", CompileVerifyAndRun(source));
    }

    [Fact]
    public void PositionalDataClassMember_GetOnlyInterfaceProperty_StillVerifiesAndRuns()
    {
        const string source = """
            package S3
            import System

            interface IBox3 {
                prop Value int32 { get; }
            }

            data class Box3(Value int32) : IBox3

            func Main() {
                let box IBox3 = Box3(11)
                Console.WriteLine(box.Value)
            }
            """;

        Assert.Equal($"11{Environment.NewLine}", CompileVerifyAndRun(source));
    }

    [Fact]
    public void PositionalDataStructMember_SettableInterfaceProperty_ReportsGS0502AndDoesNotEmit()
    {
        const string source = """
            package S4

            interface IBox4 {
                prop Value int32 { get; set; }
            }

            data struct Box4(Value int32) : IBox4
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains("GS0502", output, StringComparison.Ordinal);
        Assert.Contains("positional member 'Value'", output, StringComparison.Ordinal);
        Assert.Contains("IBox4.Value", output, StringComparison.Ordinal);
    }

    [Fact]
    public void PositionalDataClassMember_GenericSettableInterfaceProperty_ReportsGS0502AndDoesNotEmit()
    {
        const string source = """
            package S5

            interface IBox[T] {
                prop Value T { get; set; }
            }

            data class Box(Value int32) : IBox[int32]
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains("GS0502", output, StringComparison.Ordinal);
        Assert.Contains("IBox[int32].Value", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedInitOnlyInterfaces_OrdinarySetters_ReportGS0502AndDoNotEmit()
    {
        const string source = """
            package S6
            import CsInit

            class Box : IBox {
                prop Value int32 { get; set; }
            }

            class Item {
            }

            class GenericBox : IGenericBox[Item] {
                prop Value Item { get; set; }
            }
            """;

        var fixtureDirectory = CreateWorkDirectory();
        try
        {
            var referencePath = CompileCSharpFixture(
                fixtureDirectory,
                """
                namespace CsInit;
                public interface IBox
                {
                    int Value { get; init; }
                }

                public interface IGenericBox<T>
                {
                    T Value { get; init; }
                }
                """);

            var output = CompileExpectingFailure(source, referencePath);

            Assert.Equal(2, output.Split("GS0502", StringSplitOptions.None).Length - 1);
            Assert.Contains("uses accessor 'set'", output, StringComparison.Ordinal);
            Assert.Contains("requires 'init'", output, StringComparison.Ordinal);
            Assert.Contains(
                "interface property 'CsInit.IGenericBox[Item].Value'",
                output,
                StringComparison.Ordinal);
            Assert.DoesNotContain("CsInit.IGenericBox`1[[", output, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(fixtureDirectory, recursive: true);
        }
    }

    [Fact]
    public void ImportedGSharpConstructedGenericInterface_DiagnosticUsesGSharpTypeSyntax()
    {
        const string library = """
            package GLib2

            interface IBase[T] {
                func BaseEcho(v T) T;
            }

            interface IGBox[T] : IBase[T] {
                prop V T { get; init; }
                prop OnlyGet T { get; }
                func Echo(v T) T;
                func Take(v IBase[T]) void;
            }
            """;
        const string source = """
            package Consumer
            import GLib2

            class Box : IGBox[int32] {
                prop V int32 { get; set; }
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var librarySourcePath = Path.Combine(directory, "GLib2.gs");
            var libraryPath = Path.Combine(directory, "GLib2.dll");
            File.WriteAllText(librarySourcePath, library);
            var (libraryExitCode, libraryOutput) = Compile(
                "/out:" + libraryPath,
                "/target:library",
                "/targetframework:net10.0",
                librarySourcePath);
            Assert.True(libraryExitCode == 0, "gsc failed:\n" + libraryOutput);

            var output = CompileExpectingFailure(source, libraryPath);

            Assert.Contains(
                "interface property 'GLib2.IGBox[int32].V'",
                output,
                StringComparison.Ordinal);
            Assert.Contains(
                "Class 'Box' does not implement interface method 'GLib2.IGBox[int32].OnlyGet'.",
                output,
                StringComparison.Ordinal);
            Assert.Contains(
                "Class 'Box' does not implement interface method 'GLib2.IGBox[int32].Echo(int32)'.",
                output,
                StringComparison.Ordinal);
            Assert.Contains(
                "Class 'Box' does not implement interface method 'GLib2.IGBox[int32].Take(GLib2.IBase[int32])'.",
                output,
                StringComparison.Ordinal);
            Assert.Contains(
                "Class 'Box' does not implement interface method 'GLib2.IBase[int32].BaseEcho(int32)'.",
                output,
                StringComparison.Ordinal);
            Assert.DoesNotContain("GLib2.IGBox`1[[", output, StringComparison.Ordinal);
            Assert.DoesNotContain("GLib2.IBase`1[[", output, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void SymbolicImportedGenericInterface_DiagnosticUsesSymbolicTypeArgument()
    {
        const string source = """
            package Symbolic
            import System

            class Shape : IEquatable[Shape] {
            }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains(
            "Class 'Shape' does not implement interface method 'System.IEquatable[Shape].Equals(T)'.",
            output,
            StringComparison.Ordinal);
        Assert.DoesNotContain("System.IEquatable`1[[", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedConstructedGenericConstraint_DiagnosticUsesGSharpTypeSyntax()
    {
        const string source = """
            package Constraint
            import System.Collections.Generic

            func F[T List[int32]](value T) {
            }

            func Use() {
                F[string]("x")
            }
            """;

        var output = CompileExpectingFailure(source);

        Assert.Contains(
            "Type argument 'string' for type parameter 'T' does not satisfy the 'System.Collections.Generic.List[int32]' constraint.",
            output,
            StringComparison.Ordinal);
        Assert.DoesNotContain("System.Collections.Generic.List`1[[", output, StringComparison.Ordinal);
    }

    [Fact]
    public void GSharpInitOnlyInterface_ValidImplementationsVerifyAndLoad()
    {
        const string source = """
            package S7

            interface IBox {
                prop Value int32 { get; init; }
            }

            class ImplicitBox : IBox {
                prop Value int32 { get; init; }
            }

            class ExplicitBox : IBox {
                private prop (IBox) Value int32 { get; init; }
            }

            data class PositionalBox(Value int32) : IBox
            """;

        CompileVerifyAndLoad(source);
    }

    private static string CompileExpectingFailure(string source, string referencePath = null)
    {
        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

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
            var (exitCode, output) = Compile(arguments.ToArray());

            Assert.NotEqual(0, exitCode);
            Assert.False(File.Exists(outputPath), "gsc must not emit an assembly after GS0502");
            return output;
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileCSharpFixture(string directory, string source)
    {
        var outputPath = Path.Combine(directory, "CsInit.dll");
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            .Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "CsInit",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var output = File.Create(outputPath);
        var result = compilation.Emit(output);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath);

            Assert.True(exitCode == 0, "gsc failed:\n" + output);
            IlVerifier.Verify(outputPath);
            _ = EmittedFixture.Load(outputPath).GetTypes();

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start emitted program.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "Emitted program timed out.");
            Assert.True(process.ExitCode == 0, $"Program exited {process.ExitCode}:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void CompileVerifyAndLoad(string source)
    {
        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath);

            Assert.True(exitCode == 0, "gsc failed:\n" + output);
            IlVerifier.Verify(outputPath);
            _ = EmittedFixture.Load(outputPath).GetTypes();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
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
            "Issue2875",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
