// <copyright file="Issue3100FieldOffsetDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issues #3100 and #3115: explicit field layout must match the CLR across
/// bare <c>gsc</c>, explicit-output <c>gsc</c>, and <c>gsi</c> emitted drivers.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3100FieldOffsetDriverTests
{
    public static TheoryData<string> LayoutCases => new()
    {
        "FullOverlap",
        "PartialOverlap",
        "DefaultNoOverlap",
        "Sequential",
        "ExplicitNoOverlap",
    };

    [Theory]
    [MemberData(nameof(LayoutCases))]
    public void FieldLayout_AgreesAcrossEmittedDrivers(string layoutCase)
    {
        var source = SourceFor(layoutCase);
        var root = CreateEmptyDirectory(layoutCase);
        try
        {
            var bare = RunBareGsc(source, CreateEmptyDirectory(root, "bare"));
            var emitted = RunEmitted(source, layoutCase, CreateEmptyDirectory(root, "emit"));
            var gsi = RunGsi(source, CreateEmptyDirectory(root, "gsi"));

            var expected = layoutCase is "FullOverlap" or "PartialOverlap"
                ? $"2{Environment.NewLine}11{Environment.NewLine}22{Environment.NewLine}33{Environment.NewLine}44{Environment.NewLine}44"
                : $"1{Environment.NewLine}11{Environment.NewLine}22{Environment.NewLine}33{Environment.NewLine}33{Environment.NewLine}44";
            Assert.Equal(expected, emitted);
            Assert.Equal(emitted, bare);
            Assert.Equal(emitted, gsi);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData(0, "int64")]
    [InlineData(4, "int32")]
    public void ReferenceAndPrimitiveOverlapReportsGs0518AcrossEmittedDrivers(
        int primitiveOffset,
        string primitiveType)
    {
        var source = $$"""
            package Issue3115Invalid
            import System
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Explicit, Size: 8)
            struct Bad {
                @FieldOffset(0) var Text string
                @FieldOffset({{primitiveOffset}}) var Bits {{primitiveType}}
            }

            var value = Bad{Text: "x", Bits: 0}
            Console.WriteLine(value.Bits)
            """;
        AssertGs0518AcrossEmittedDrivers(source, "ReferencePrimitiveOverlap");
    }

    [Fact]
    public void ForwardDeclaredValueTypeOverlapReportsGs0518AcrossEmittedDrivers()
    {
        const string Source = """
            package Issue3115ForwardOverlap
            import System
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Explicit, Size: 16)
            struct Bad {
                @FieldOffset(8) var Text string
                @FieldOffset(4) var Bits Payload
            }
            struct Payload { var Value int64 }

            var value = Bad{Text: "x", Bits: Payload{Value: 0}}
            Console.WriteLine(value.Bits.Value)
            """;

        AssertGs0518AcrossEmittedDrivers(Source, "ForwardValueOverlap");
    }

    [Fact]
    public void NestedStructOverlapReportsGs0518AcrossEmittedDrivers()
    {
        const string Source = """
            package Issue3115NestedOverlap
            import System
            import System.Runtime.InteropServices
            struct Outer {
                @StructLayout(LayoutKind.Explicit, Size: 8)
                struct Inner {
                    @FieldOffset(0) var Text string
                    @FieldOffset(0) var Bits int64
                }
            }
            var value = 11
            Console.WriteLine(value)
            """;

        AssertGs0518AcrossEmittedDrivers(Source, "NestedOverlap", 8, 29, 33);
    }

    [Theory]
    [InlineData(0, 6)]
    [InlineData(24, 30)]
    public void MisalignedReferenceReportsGs0518WithRealLocationAcrossEmittedDrivers(
        int paddingLines,
        int expectedLine)
    {
        var source = string.Join(
            "\n",
            new[]
            {
                "package Issue3115MisalignedReference",
                "import System",
                "import System.Runtime.InteropServices",
            }
            .Concat(Enumerable.Repeat("// padding", paddingLines))
            .Concat(
            [
                "@StructLayout(LayoutKind.Explicit, Size: 16)",
                "struct Bad {",
                "    @FieldOffset(4) var Text string",
                "    @FieldOffset(12) var Bits int32",
                "}",
                "var value = Bad{Text: \"x\", Bits: 11}",
                "Console.WriteLine(value.Bits)",
            ]));

        AssertGs0518AcrossEmittedDrivers(
            source,
            $"MisalignedReference{paddingLines}",
            expectedLine,
            25,
            29,
            "offset 4 is not aligned to pointer size");
    }

    [Fact]
    public void WorkingReferenceLayoutsRemainValidAcrossEmittedDrivers()
    {
        var source = ReferenceLayoutCorpusSource();
        var root = CreateEmptyDirectory("ReferenceLayoutCorpus");
        try
        {
            var bare = RunBareGsc(source, CreateEmptyDirectory(root, "bare"));
            var emitted = RunEmitted(source, CreateEmptyDirectory(root, "emit"));
            var gsi = RunGsi(source, CreateEmptyDirectory(root, "gsi"));

            Assert.Equal($"A{Environment.NewLine}11{Environment.NewLine}C{Environment.NewLine}D{Environment.NewLine}22{Environment.NewLine}44{Environment.NewLine}E{Environment.NewLine}55", emitted);
            Assert.Equal(emitted, bare);
            Assert.Equal(emitted, gsi);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ExplicitLayoutStorageInvariantCannotBeBypassed()
    {
        Assert.Equal(typeof(object), typeof(StructValue.FieldCollection).BaseType);
        var backing = typeof(StructValue).GetField(
            "explicitLayoutValue",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(backing);
        Assert.True(backing.IsInitOnly);
    }

    private static string RunBareGsc(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        File.WriteAllText(sourcePath, source);
        var (exitCode, stdout, stderr) = CaptureConsole(
            () => GSharp.Compiler.Program.Main([sourcePath]));

        Assert.True(exitCode == 0, $"bare gsc failed ({exitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return NormalizeValues(stdout);
    }

    private static string RunGsi(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        File.WriteAllText(sourcePath, source);
        var (exitCode, stdout, stderr) = CaptureConsole(
            () => GSharp.Repl.Program.Main([sourcePath]));

        Assert.True(exitCode == 0, $"gsi failed ({exitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return NormalizeValues(stdout);
    }

    private static string RunEmitted(string source, string layoutCase, string directory)
    {
        return RunEmitted(
            source,
            directory,
            assemblyPath => VerifyMetadata(assemblyPath, layoutCase));
    }

    private static string RunEmitted(
        string source,
        string directory,
        Action<string> verifyAssembly = null)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        var outputPath = Path.Combine(directory, $"Issue3100{Guid.NewGuid():N}.dll");
        File.WriteAllText(sourcePath, source);

        var (compileExit, stdout, stderr) = CaptureConsole(
            () => GSharp.Compiler.Program.Main(
                ["/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath]));
        Assert.True(compileExit == 0, $"emit failed ({compileExit})\nstdout:\n{stdout}\nstderr:\n{stderr}");

        verifyAssembly?.Invoke(outputPath);

        var result = DotnetProcess.Run(directory, outputPath);
        Assert.True(
            result.ExitCode == 0,
            $"emitted program failed ({result.ExitCode})\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");
        return NormalizeValues(result.StandardOutput);
    }

    private static (string SourcePath, string Output) RunDiagnostic(
        string source,
        string directory,
        Func<string, int> run)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        File.WriteAllText(sourcePath, source);
        var (exitCode, stdout, stderr) = CaptureConsole(() => run(sourcePath));

        Assert.True(exitCode == 1, $"expected diagnostic exit 1, got {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return (sourcePath, stdout + stderr);
    }

    private static void AssertGs0518AcrossEmittedDrivers(
        string source,
        string name,
        int line = 8,
        int startColumn = 25,
        int endColumn = 29,
        string reason = "it overlaps non-reference field 'Bits'")
    {
        var root = CreateEmptyDirectory(name);
        try
        {
            var bare = RunDiagnostic(
                source,
                CreateEmptyDirectory(root, "bare"),
                path => GSharp.Compiler.Program.Main([path]));
            var emitted = RunDiagnostic(
                source,
                CreateEmptyDirectory(root, "emit"),
                path => GSharp.Compiler.Program.Main(
                    ["/out:" + Path.Combine(root, "emit", "probe.dll"), path]));
            var gsi = RunDiagnostic(
                source,
                CreateEmptyDirectory(root, "gsi"),
                path => GSharp.Repl.Program.Main([path]));

            AssertGs0518(bare.SourcePath, bare.Output, line, startColumn, endColumn, reason);
            AssertGs0518(emitted.SourcePath, emitted.Output, line, startColumn, endColumn, reason);
            AssertGs0518(gsi.SourcePath, gsi.Output, line, startColumn, endColumn, reason);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void AssertGs0518(
        string sourcePath,
        string output,
        int line,
        int startColumn,
        int endColumn,
        string reason)
    {
        Assert.Contains(
            $"{sourcePath}({line},{startColumn},{line},{endColumn})",
            output,
            StringComparison.Ordinal);
        Assert.Contains("GS0518", output, StringComparison.Ordinal);
        Assert.Contains("reference-typed field 'Text'", output, StringComparison.Ordinal);
        Assert.Contains(reason, output, StringComparison.Ordinal);
        Assert.DoesNotContain("GSharpLayout_", output, StringComparison.Ordinal);
        Assert.DoesNotContain("GSharp.Interpreter.Layouts", output, StringComparison.Ordinal);
    }

    private static void VerifyMetadata(string assemblyPath, string layoutCase)
    {
        CollectibleAssembly.Inspect(
            assemblyPath,
            assembly =>
            {
                var types = assembly.GetTypes();
                var cell = types.Single(t => t.Name == "Cell");
                var wrapper = types.Single(t => t.Name == "Wrapper");

                var expectedLayout = layoutCase is "FullOverlap" or "PartialOverlap" or "ExplicitNoOverlap"
                    ? LayoutKind.Explicit
                    : LayoutKind.Sequential;
                Assert.Equal(expectedLayout, cell.StructLayoutAttribute?.Value);
                Assert.Equal(LayoutKind.Sequential, wrapper.StructLayoutAttribute?.Value);
                Assert.Equal(0, Marshal.OffsetOf(wrapper, "Value").ToInt32());
                Assert.Equal(0, Marshal.OffsetOf(cell, "Nested").ToInt32());
                Assert.Equal(
                    layoutCase switch
                    {
                        "FullOverlap" => 0,
                        "PartialOverlap" => 1,
                        _ => 4,
                    },
                    Marshal.OffsetOf(cell, "Alias").ToInt32());
            });
    }

    private static (int ExitCode, string Stdout, string Stderr) CaptureConsole(Func<int> action)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (action(), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string NormalizeValues(string output) =>
        string.Join(
            "\n",
            output.ReplaceLineEndings(Environment.NewLine)
                .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
                .Where(line => line != "Success."));

    private static string CreateEmptyDirectory(string name)
    {
        var parent = Path.Combine(AppContext.BaseDirectory, "issue3100-probes");
        return CreateEmptyDirectory(parent, $"{name}-{Guid.NewGuid():N}");
    }

    private static string CreateEmptyDirectory(string parent, string name)
    {
        var path = Path.Combine(parent, name);
        Directory.CreateDirectory(path);
        Assert.Empty(Directory.EnumerateFileSystemEntries(path));
        return path;
    }

    private static string SourceFor(string layoutCase)
    {
        var package = $"Issue3100{layoutCase}";
        return layoutCase switch
        {
            "FullOverlap" => $$$"""
                package {{{package}}}
                import System
                import System.Runtime.InteropServices

                struct Payload { var Value int32 }
                @StructLayout(LayoutKind.Explicit, Size: 4)
                struct Cell {
                    @FieldOffset(0) var Nested Payload
                    @FieldOffset(0) var Alias int32
                }
                struct Wrapper { var Value Cell }
                func setAlias(ref value int32) { value = 44 }

                var cell = Cell{Nested: Payload{Value: 1}, Alias: 2}
                Console.WriteLine(cell.Nested.Value)
                cell.Nested.Value = 11
                Console.WriteLine(cell.Alias)
                cell.Alias = 22
                Console.WriteLine(cell.Nested.Value)
                var wrapper = Wrapper{Value: Cell{Nested: Payload{Value: 3}, Alias: 4}}
                wrapper.Value.Nested.Value = 33
                Console.WriteLine(wrapper.Value.Alias)
                setAlias(ref wrapper.Value.Alias)
                Console.WriteLine(wrapper.Value.Nested.Value)
                Console.WriteLine(wrapper.Value.Alias)
                """,
            "PartialOverlap" => $$$"""
                package {{{package}}}
                import System
                import System.Runtime.InteropServices

                struct Payload { var Head uint8 var Value uint8 var Tail uint8 }
                @StructLayout(LayoutKind.Explicit, Size: 4)
                struct Cell {
                    @FieldOffset(0) var Nested Payload
                    @FieldOffset(1) var Alias uint16
                }
                struct Wrapper { var Value Cell }
                func setAlias(ref value uint16) { value = 44 }

                var cell = Cell{Nested: Payload{Head: 0, Value: 1, Tail: 0}, Alias: 2}
                Console.WriteLine(cell.Nested.Value)
                cell.Nested.Value = 11
                Console.WriteLine(cell.Alias)
                cell.Alias = 22
                Console.WriteLine(cell.Nested.Value)
                var wrapper = Wrapper{Value: Cell{Nested: Payload{Head: 0, Value: 3, Tail: 0}, Alias: 4}}
                wrapper.Value.Nested.Value = 33
                Console.WriteLine(wrapper.Value.Alias)
                setAlias(ref wrapper.Value.Alias)
                Console.WriteLine(wrapper.Value.Nested.Value)
                Console.WriteLine(wrapper.Value.Alias)
                """,
            "DefaultNoOverlap" => NonOverlappingSource(package, null),
            "Sequential" => NonOverlappingSource(package, "@StructLayout(LayoutKind.Sequential)"),
            "ExplicitNoOverlap" => NonOverlappingSource(package, "@StructLayout(LayoutKind.Explicit, Size: 8)"),
            _ => throw new ArgumentOutOfRangeException(nameof(layoutCase)),
        };
    }

    private static string NonOverlappingSource(string package, string layoutAttribute)
    {
        var fields = layoutAttribute?.Contains("Explicit", StringComparison.Ordinal) == true
            ? """
                    @FieldOffset(0) var Nested Payload
                    @FieldOffset(4) var Alias int32
                """
            : """
                    var Nested Payload
                    var Alias int32
                """;
        var attribute = layoutAttribute == null ? string.Empty : layoutAttribute + "\n";
        return $$$"""
            package {{{package}}}
            import System
            import System.Runtime.InteropServices

            struct Payload { var Value int32 }
            {{{attribute}}}struct Cell {
            {{{fields}}}
            }
            struct Wrapper { var Value Cell }
            func setAlias(ref value int32) { value = 44 }

            var cell = Cell{Nested: Payload{Value: 1}, Alias: 2}
            Console.WriteLine(cell.Nested.Value)
            cell.Nested.Value = 11
            Console.WriteLine(cell.Nested.Value)
            cell.Alias = 22
            Console.WriteLine(cell.Alias)
            var wrapper = Wrapper{Value: Cell{Nested: Payload{Value: 3}, Alias: 4}}
            wrapper.Value.Nested.Value = 33
            Console.WriteLine(wrapper.Value.Nested.Value)
            setAlias(ref wrapper.Value.Alias)
            Console.WriteLine(wrapper.Value.Nested.Value)
            Console.WriteLine(wrapper.Value.Alias)
            """;
    }

    private static string ReferenceLayoutCorpusSource() =>
        """
        package Issue3115Corpus
        import System
        import System.Runtime.InteropServices

        @StructLayout(LayoutKind.Explicit, Size: 16)
        struct RefAndPrimitive {
            @FieldOffset(0) var Text string
            @FieldOffset(8) var Bits int64
        }

        @StructLayout(LayoutKind.Explicit, Size: 8)
        struct RefAlias {
            @FieldOffset(0) var Text string
            @FieldOffset(0) var Any object
        }

        @StructLayout(LayoutKind.Sequential)
        struct SequentialControl {
            var Text string
            var Bits int64
        }

        @StructLayout(LayoutKind.Explicit, Size: 8)
        struct PrimitiveUnion {
            @FieldOffset(0) var Low int32
            @FieldOffset(0) var Wide int64
        }

        @StructLayout(LayoutKind.Explicit, Size: 16)
        struct RefAndValue {
            @FieldOffset(8) var Text string
            @FieldOffset(0) var Value Payload
        }
        struct Payload { var Value int64 }

        var separated = RefAndPrimitive{Text: "A", Bits: 11L}
        Console.WriteLine(separated.Text)
        Console.WriteLine(separated.Bits)
        var references = RefAlias{Text: "B", Any: "C"}
        Console.WriteLine(references.Text)
        var sequential = SequentialControl{Text: "D", Bits: 22L}
        Console.WriteLine(sequential.Text)
        Console.WriteLine(sequential.Bits)
        var primitive = PrimitiveUnion{Low: 0, Wide: 33L}
        primitive.Low = 44
        Console.WriteLine(primitive.Wide)
        var nested = RefAndValue{Text: "E", Value: Payload{Value: 55L}}
        Console.WriteLine(nested.Text)
        Console.WriteLine(nested.Value.Value)
        """;
}
