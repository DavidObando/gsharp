// <copyright file="Issue2870ReferenceAssemblyOverrideSlotEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2870 — <c>MemberDefEmitter.EmitPropertyGetter</c>/<c>EmitPropertySetter</c>
/// tested <c>IsVirtual</c> before <c>IsOverride</c>. The two flags are
/// independent (<c>IsVirtual</c> means "declared <c>open</c>",
/// <c>IsOverride</c> means "overrides a base property"), so an
/// <c>open override prop</c> set both, took the virtual branch, and wrongly
/// acquired <c>NewSlot</c>.
/// <para>
/// The implementation assembly routes computed-body accessors through
/// <c>FunctionEmitter</c> and got this right, so the defect only surfaced on
/// the path that emits every property here: the metadata-only
/// (<c>/refout</c>) emit. MSBuild passes the REFERENCE assembly to downstream
/// compilations, so a consumer saw the override as a fresh virtual, which made
/// <c>PropertySymbol.IsAbstract</c> true, marked the declaring type abstract,
/// and produced <c>GS0386</c> at every construction site.
/// </para>
/// </summary>
public class Issue2870ReferenceAssemblyOverrideSlotEmitTests
{
    [Fact]
    public void OverridingDataClassProperty_HasNoNewSlotInEitherAssembly()
    {
        const string source = """
            package i2870a

            open data class CallbackChallenge {
                open prop Kind string {
                    get;
                }
            }

            open data class CaptchaChallenge(ImageBytes []uint8) : CallbackChallenge {
                open override prop Kind string -> "captcha"
            }
            """;

        var (implementation, reference) = CompileWithReference(source, "i2870a.dll");

        AssertNoNewSlot(implementation, "CaptchaChallenge", "get_Kind");
        AssertNoNewSlot(reference, "CaptchaChallenge", "get_Kind");
        AssertNewSlot(implementation, "CallbackChallenge", "get_Kind");
        AssertNewSlot(reference, "CallbackChallenge", "get_Kind");
    }

    [Fact]
    public void OverridingClassProperty_HasNoNewSlotInEitherAssembly()
    {
        const string source = """
            package i2870b

            open class Shape {
                open prop Name string {
                    get;
                }
            }

            open class Square : Shape {
                open override prop Name string -> "square"
            }
            """;

        var (implementation, reference) = CompileWithReference(source, "i2870b.dll");

        AssertNoNewSlot(implementation, "Square", "get_Name");
        AssertNoNewSlot(reference, "Square", "get_Name");
    }

    [Fact]
    public void OverridingSettableProperty_HasNoNewSlotInEitherAssembly()
    {
        // The setter emitter carries the same ordering bug as the getter.
        const string source = """
            package i2870c

            open class Holder {
                open prop Value string {
                    get;
                    set;
                }
            }

            open class Derived : Holder {
                private var backing string = ""

                open override prop Value string {
                    get -> this.backing
                    set { this.backing = value }
                }
            }
            """;

        var (implementation, reference) = CompileWithReference(source, "i2870c.dll");

        AssertNoNewSlot(implementation, "Derived", "get_Value");
        AssertNoNewSlot(implementation, "Derived", "set_Value");
        AssertNoNewSlot(reference, "Derived", "get_Value");
        AssertNoNewSlot(reference, "Derived", "set_Value");
    }

    [Fact]
    public void ConsumerCompilingAgainstReferenceAssembly_CanConstructTheOverridingType()
    {
        // End-to-end guard: this is exactly what MSBuild does for a
        // ProjectReference, and what produced GS0386 in the Oahu migration.
        const string library = """
            package i2870lib

            open data class CallbackChallenge {
                open prop Kind string {
                    get;
                }
            }

            open data class CaptchaChallenge(ImageBytes []uint8) : CallbackChallenge {
                open override prop Kind string -> "captcha"
            }
            """;

        const string consumer = """
            package i2870d
            import i2870lib

            func Main() {
                let c = CaptchaChallenge([]uint8{1, 2})
                System.Console.WriteLine(c.Kind)
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_2870_consumer_").FullName;
        try
        {
            var libSrc = Path.Combine(tempDir, "i2870lib.gs");
            var libDll = Path.Combine(tempDir, "impl", "i2870lib.dll");
            var libRef = Path.Combine(tempDir, "ref", "i2870lib.dll");
            Directory.CreateDirectory(Path.GetDirectoryName(libDll));
            Directory.CreateDirectory(Path.GetDirectoryName(libRef));
            File.WriteAllText(libSrc, library);
            Compile(new[]
            {
                "/out:" + libDll,
                "/refout:" + libRef,
                "/target:library",
                "/targetframework:net10.0",
                libSrc,
            });

            var consumerSrc = Path.Combine(tempDir, "consumer.gs");
            File.WriteAllText(consumerSrc, consumer);

            // Compiling against the REFERENCE assembly is the case that broke.
            Compile(new[]
            {
                "/out:" + Path.Combine(tempDir, "consumer.dll"),
                "/target:exe",
                "/targetframework:net10.0",
                "/r:" + libRef,
                consumerSrc,
            });
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    [Fact]
    public void NonOverridingVirtualProperty_KeepsNewSlot()
    {
        // Control: a property that genuinely introduces a virtual slot must
        // still carry NewSlot in both assemblies.
        const string source = """
            package i2870e

            open class Root {
                open prop Tag string -> "root"
            }
            """;

        var (implementation, reference) = CompileWithReference(source, "i2870e.dll");

        AssertNewSlot(implementation, "Root", "get_Tag");
        AssertNewSlot(reference, "Root", "get_Tag");
    }

    private static void AssertNoNewSlot(string assemblyPath, string typeName, string methodName)
    {
        var attributes = ReadMethodAttributes(assemblyPath, typeName, methodName);
        Assert.True(
            (attributes & MethodAttributes.Virtual) != 0,
            $"{typeName}::{methodName} in '{Path.GetFileName(assemblyPath)}' should be virtual but is {attributes}.");
        Assert.True(
            (attributes & MethodAttributes.NewSlot) == 0,
            $"{typeName}::{methodName} in '{Path.GetFileName(assemblyPath)}' overrides a base slot " +
            $"and must not carry NewSlot, but is {attributes}.");
    }

    private static void AssertNewSlot(string assemblyPath, string typeName, string methodName)
    {
        var attributes = ReadMethodAttributes(assemblyPath, typeName, methodName);
        Assert.True(
            (attributes & MethodAttributes.NewSlot) != 0,
            $"{typeName}::{methodName} in '{Path.GetFileName(assemblyPath)}' introduces a virtual slot " +
            $"and must carry NewSlot, but is {attributes}.");
    }

    private static MethodAttributes ReadMethodAttributes(string assemblyPath, string typeName, string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var type = reader.GetTypeDefinition(typeHandle);
            if (!string.Equals(reader.GetString(type.Name), typeName, StringComparison.Ordinal))
            {
                continue;
            }

            foreach (var methodHandle in type.GetMethods())
            {
                var method = reader.GetMethodDefinition(methodHandle);
                if (string.Equals(reader.GetString(method.Name), methodName, StringComparison.Ordinal))
                {
                    return method.Attributes;
                }
            }
        }

        throw new InvalidOperationException(
            $"'{typeName}::{methodName}' not found in '{assemblyPath}'.");
    }

    private static (string Implementation, string Reference) CompileWithReference(string source, string outputName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2870_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, outputName);
        var refPath = Path.Combine(
            tempDir,
            Path.GetFileNameWithoutExtension(outputName) + ".ref" + Path.GetExtension(outputName));
        File.WriteAllText(srcPath, source);

        Compile(new[]
        {
            "/out:" + outPath,
            "/refout:" + refPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        });

        return (outPath, refPath);
    }

    private static void Compile(string[] args)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
    }
}
