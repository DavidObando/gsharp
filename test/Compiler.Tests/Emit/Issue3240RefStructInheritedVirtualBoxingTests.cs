// <copyright file="Issue3240RefStructInheritedVirtualBoxingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3240: inherited CLR instance methods on a by-ref-like receiver require
/// illegal boxing and must be rejected before an assembly is emitted.
/// </summary>
public sealed class Issue3240RefStructInheritedVirtualBoxingTests
{
    public static TheoryData<string> InheritedCalls => new()
    {
        "b.ToString()",
        "b.GetHashCode()",
        "b.Equals(nil)",
        "b.GetType()",
    };

    [Theory]
    [MemberData(nameof(InheritedCalls))]
    public void InheritedObjectMethod_OnRefStruct_ReportsBoxingAtCallAndDoesNotEmit(string call)
    {
        var source = $$"""
            ref struct Bare {
                var id int32
            }

            func Run() {
                var b = Bare{id: 42}
                var result = {{call}}
            }
            Run()
            """;

        AssertRejectedWithoutAssembly(
            source,
            call[(call.IndexOf('.', StringComparison.Ordinal) + 1)..],
            $"invoke inherited method '{MethodName(call)}' because dispatch requires boxing the receiver");
    }

    [Fact]
    public void InheritedObjectMethod_OnConstructedGenericRefStruct_ReportsBoxing()
    {
        const string Source = """
            ref struct Bare[T any] {
                var value T
            }

            func Run() {
                var b = Bare[int32]{value: 42}
                var result = b.ToString()
            }
            Run()
            """;

        AssertRejectedWithoutAssembly(
            Source,
            "ToString()",
            "invoke inherited method 'ToString' because dispatch requires boxing the receiver");
    }

    [Fact]
    public void InheritedObjectMethod_OnImportedRefStruct_ReportsBoxing()
    {
        const string Source = """
            import System

            func Run() {
                var values []int32 = []int32{11, 22}
                var span ReadOnlySpan[int32] = values
                var result = span.GetType()
            }
            Run()
            """;

        AssertRejectedWithoutAssembly(
            Source,
            "GetType()",
            "invoke inherited method 'GetType' because dispatch requires boxing the receiver");
    }

    [Fact]
    public void RefStructConversionToUserInterface_ReportsExistingBoxingDiagnostic()
    {
        const string Source = """
            interface Marker {
                func Mark() string;
            }

            ref struct Bare : Marker {
                var id int32
                func Mark() string -> "marker-55"
            }

            func Run() {
                var b = Bare{id: 42}
                var marker Marker = b
            }
            Run()
            """;

        AssertRejectedWithoutAssembly(
            Source,
            "b",
            "be boxed or converted to the reference type 'Marker'");
    }

    [Fact]
    public void InferredRefStructGenericArgument_ReportsExistingGenericArgumentDiagnostic()
    {
        const string Source = """
            ref struct Bare {
                var id int32
            }

            func Use[T any](value T) {
                var text = value.ToString()
            }

            func Run() {
                var b = Bare{id: 42}
                Use(b)
            }
            Run()
            """;

        AssertRejectedWithoutAssembly(Source, "Use", "be used as a generic type argument");
    }

    [Fact]
    public void InferredRefStructGenericInstanceMethodArgument_ReportsExistingGenericArgumentDiagnostic()
    {
        const string Source = """
            ref struct Bare {
                var id int32
            }

            class Host {
                func Use[T any](value T) {
                    var text = value.ToString()
                }
            }

            func Run() {
                var b = Bare{id: 42}
                var host = Host()
                host.Use(b)
            }
            Run()
            """;

        AssertRejectedWithoutAssembly(Source, "Use", "be used as a generic type argument");
    }

    [Fact]
    public void InferredRefStructGenericExtensionArgument_ReportsExistingGenericArgumentDiagnostic()
    {
        const string Source = """
            ref struct Bare {
                var id int32
            }

            func (host string) Use[T any](value T) {
                var text = value.ToString()
            }

            func Run() {
                var b = Bare{id: 42}
                "host".Use(b)
            }
            Run()
            """;

        AssertRejectedWithoutAssembly(Source, "Use", "be used as a generic type argument");
    }

    [Fact]
    public void DeclaredObjectMethods_OnRefStruct_RemainDirectCalls()
    {
        const string Source = """
            import System

            ref struct Bare {
                var id int32
                override func ToString() string -> "declared-11"
                override func GetHashCode() int32 -> 22
                override func Equals(value object) bool -> true
                func GetType() string -> "declared-44"
            }

            func Run() {
                var b = Bare{id: 42}
                var other object = "other"
                Console.WriteLine(b.ToString())
                Console.WriteLine(b.GetHashCode())
                Console.WriteLine(b.Equals(other))
                Console.WriteLine(b.GetType())
                Console.WriteLine("implicit=${b}")
            }
            Run()
            """;

        Assert.Equal(
            string.Join(Environment.NewLine, "declared-11", "22", "True", "declared-44", "implicit=declared-11", string.Empty),
            CompileAndRun(Source).StandardOutput);
    }

    [Fact]
    public void InheritedObjectMethods_OnPlainStruct_RemainCallable()
    {
        const string Source = """
            import System

            struct Plain {
                var id int32
            }

            func Run() {
                var value = Plain{id: 42}
                Console.WriteLine(value.ToString())
                Console.WriteLine(value.GetHashCode())
                Console.WriteLine(value.Equals(nil))
                Console.WriteLine(value.GetType().FullName)
            }
            Run()
            """;

        var lines = CompileAndRun(Source).StandardOutput.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(4, lines.Length);
        Assert.Equal("Default.Plain", lines[0]);
        Assert.True(int.TryParse(lines[1], out _), $"Expected integer hash code, got '{lines[1]}'.");
        Assert.Equal("False", lines[2]);
        Assert.Equal("Default.Plain", lines[3]);
    }

    [Fact]
    public void ImportedRefStructDeclaredMethod_AndUserInterfaceMethod_RemainDirectCalls()
    {
        const string Source = """
            import System

            interface Marker {
                func Mark() string;
            }

            ref struct Bare : Marker {
                var id int32
                func Mark() string -> "marker-55"
            }

            func Run() {
                var values []int32 = []int32{11, 22}
                var span ReadOnlySpan[int32] = values
                var bare = Bare{id: 42}
                Console.WriteLine(span.ToString())
                Console.WriteLine(bare.Mark())
            }
            Run()
            """;

        Assert.Equal(
            string.Join(Environment.NewLine, "System.ReadOnlySpan<Int32>[2]", "marker-55", string.Empty),
            CompileAndRun(Source).StandardOutput);
    }

    private static void AssertRejectedWithoutAssembly(
        string source,
        string expectedSpan,
        string expectedReason)
    {
        var root = Path.Combine(Environment.CurrentDirectory, $".issue3240-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var sourcePath = Path.Combine(root, "probe.gs");
        var assemblyPath = Path.Combine(root, "probe.dll");
        File.WriteAllText(sourcePath, source);

        try
        {
            var compile = CaptureConsole(
                () => GSharp.Compiler.Program.Main(
                    ["/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath]));
            var runtime = compile.ExitCode == 0 && File.Exists(assemblyPath)
                ? RunAssembly(assemblyPath)
                : default;

            Assert.True(
                compile.ExitCode != 0,
                $"Expected compile rejection, got compile rc=0; run rc={runtime.ExitCode}; stdout=[{runtime.StandardOutput}]; stderr=[{runtime.StandardError}].");
            Assert.Contains("error GS0219:", compile.StandardOutput, StringComparison.Ordinal);
            Assert.Equal($"Failed.{Environment.NewLine}", compile.StandardError);
            Assert.False(File.Exists(assemblyPath), "Compiler must not write an assembly after GS0219.");

            var tree = SyntaxTree.Parse(SourceText.From(source, "issue3240.gs"));
            var compilation = new Compilation(tree);
            using var peStream = new MemoryStream();
            var emit = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue3240");
            var diagnostic = Assert.Single(emit.Diagnostics.Where(candidate => candidate.IsError));

            Assert.False(emit.Success);
            Assert.Equal("GS0219", diagnostic.Id);
            Assert.Contains(expectedReason, diagnostic.Message, StringComparison.Ordinal);
            Assert.Equal(expectedSpan, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
            Assert.Equal(0, peStream.Length);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CompileAndRun(string source)
    {
        var root = Path.Combine(Environment.CurrentDirectory, $".issue3240-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var sourcePath = Path.Combine(root, "control.gs");
        var assemblyPath = Path.Combine(root, "control.dll");
        File.WriteAllText(sourcePath, source);

        try
        {
            var compile = CaptureConsole(
                () => GSharp.Compiler.Program.Main(
                    ["/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath]));
            Assert.Equal(0, compile.ExitCode);
            Assert.Equal(string.Empty, compile.StandardError);
            Assert.True(File.Exists(assemblyPath), "Expected control assembly.");

            var runtime = RunAssembly(assemblyPath);
            Assert.Equal(0, runtime.ExitCode);
            Assert.Equal(string.Empty, runtime.StandardError);
            return runtime;
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static (int ExitCode, string StandardOutput, string StandardError) RunAssembly(string assemblyPath)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList = { "exec", assemblyPath },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
        Assert.NotNull(process);
        var standardOutput = process.StandardOutput.ReadToEndAsync();
        var standardError = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(30_000), "Timed out running emitted assembly.");
        return (
            process.ExitCode,
            standardOutput.GetAwaiter().GetResult(),
            standardError.GetAwaiter().GetResult());
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CaptureConsole(Func<int> action)
    {
        using var standardOutput = new StringWriter();
        using var standardError = new StringWriter();
        var previousOutput = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(standardOutput);
        Console.SetError(standardError);
        try
        {
            return (action(), standardOutput.ToString(), standardError.ToString());
        }
        finally
        {
            Console.SetOut(previousOutput);
            Console.SetError(previousError);
        }
    }

    private static string MethodName(string call)
    {
        var dot = call.IndexOf('.', StringComparison.Ordinal);
        var open = call.IndexOf('(', dot + 1);
        return call[(dot + 1)..open];
    }
}
