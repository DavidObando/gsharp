// <copyright file="Issue3001StructComputedAccessorVirtualTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3001: computed struct property accessors that implement interface
/// slots must be emitted virtual.
/// </summary>
public class Issue3001StructComputedAccessorVirtualTests
{
    [Fact]
    public void OrdinaryComputedProperty_LoadsAndDispatches()
    {
        const string Source = """
            package Issue3001Ordinary
            import System

            interface IName {
                prop Label string { get; }
            }

            struct S : IName {
                prop Label string -> "hi"
            }

            var value IName = S{}
            Console.WriteLine(value.Label)
            """;

        AssertRuns(Source, nameof(OrdinaryComputedProperty_LoadsAndDispatches), "hi\n");
    }

    [Fact]
    public void ExplicitComputedIndexer_LoadsAndDispatches()
    {
        const string Source = """
            package Issue3001Explicit
            import System

            interface I {
                prop this[key int32] int32 { get; }
            }

            struct S(Base int32) : I {
                private prop (I) this[key int32] int32 -> Base + key
            }

            var value I = S(5)
            Console.WriteLine(value[7])
            """;

        AssertRuns(Source, nameof(ExplicitComputedIndexer_LoadsAndDispatches), "12\n");
    }

    [Fact]
    public void NullableSequenceComputedProperty_LoadsAndDispatches()
    {
        const string Source = """
            package Issue3001Sequence
            import System

            interface IBox {
                prop Vals sequence[int32?] { get; }
            }

            func values() sequence[int32?] {
                yield 5
                yield nil
            }

            struct Box : IBox {
                prop Vals sequence[int32?] -> values()
            }

            var box IBox = Box{}
            for value in box.Vals {
                Console.WriteLine(value == nil ? "nil" : value.ToString())
            }
            """;

        AssertRuns(
            Source,
            nameof(NullableSequenceComputedProperty_LoadsAndDispatches),
            "5\nnil\n");
    }

    [Fact]
    public void ComputedGetterAndSetter_LoadAndDispatch()
    {
        const string Source = """
            package Issue3001GetterSetter
            import System

            interface IValue {
                prop Value int32 { get; set; }
            }

            struct ValueBox : IValue {
                var Stored int32
                prop Value int32 {
                    get { return Stored }
                    set { Stored = value + 11 }
                }
            }

            var box IValue = ValueBox{}
            box.Value = 22
            Console.WriteLine(box.Value)
            """;

        AssertRuns(Source, nameof(ComputedGetterAndSetter_LoadAndDispatch), "33\n");
    }

    [Fact]
    public void AutoPropertyStruct_RemainsLoadable()
    {
        const string Source = """
            package Issue3001AutoProperty
            import System

            interface IValue {
                prop Value int32 { get; set; }
            }

            struct ValueBox : IValue {
                prop Value int32 { get; set; }
            }

            var box IValue = ValueBox{}
            box.Value = 44
            Console.WriteLine(box.Value)
            """;

        AssertRuns(Source, nameof(AutoPropertyStruct_RemainsLoadable), "44\n");
    }

    [Fact]
    public void MismatchedIndexerParameter_DoesNotPromoteOrdinaryAccessor()
    {
        const string Source = """
            package Issue3001Mismatch

            interface ITextIndexer {
                prop this[key string] int32 { get; }
            }

            struct MixedIndexer : ITextIndexer {
                prop this[key int32] int32 -> 33
                private prop (ITextIndexer) this[key string] int32 -> 22
            }
            """;

        var assemblyPath = Compile(
            Source,
            nameof(MismatchedIndexerParameter_DoesNotPromoteOrdinaryAccessor),
            target: "library");

        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(candidate => reader.GetString(candidate.Name) == "MixedIndexer");
        var getter = type.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single(method => reader.GetString(method.Name) == "get_Item");

        Assert.False((getter.Attributes & MethodAttributes.Virtual) != 0);
    }

    private static void AssertRuns(string source, string name, string expected)
    {
        var assemblyPath = Compile(source, name, target: "exe");
        var assembly = EmittedFixture.Load(assemblyPath);
        Assert.NotEmpty(assembly.GetTypes());
        IlVerifier.Verify(assemblyPath);
        Assert.Equal(expected, RunBounded(assemblyPath, name));
    }

    private static string Compile(string source, string name, string target)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3001StructComputedAccessorVirtualTests),
            name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, name + ".dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:" + target,
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        Assert.True(exitCode == 0, $"{name}: gsc failed:\n{stdout}\n{stderr}");
        return assemblyPath;
    }

    private static string RunBounded(string assemblyPath, string name)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        Assert.NotNull(process);
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(30_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        Assert.True(exited, $"{name}: emitted program timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, $"{name}: emitted program failed:\n{error}");
        return output.ReplaceLineEndings(Environment.NewLine);
    }
}
