// <copyright file="Issue4095NestedGenericOuterAttributeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4095: a <c>typeof</c> attribute argument naming a type nested inside
/// a constructed generic outer lost the enclosing type arguments and reified
/// as the open nested definition.
/// </summary>
/// <remarks>
/// <para>A constructed nested <c>StructSymbol</c> or <c>EnumSymbol</c> stores
/// the flattened outer vector on <c>EnclosingTypeArguments</c>, while a
/// struct's <c>TypeArguments</c> contains only arguments declared by the nested
/// type. The attribute serializer ignored the enclosing vector and wrote only
/// the open metadata name.</para>
/// <para>The emitted TypeDef shape is deliberately unchanged: per issue #2916,
/// each nested name's backtick suffix counts only parameters declared at that
/// level, while its GenericParam rows contain the flattened enclosing + own
/// vector. The attribute blob must use that per-level name and apply the full
/// vector.</para>
/// </remarks>
public sealed class Issue4095NestedGenericOuterAttributeTests
{
    private const int RunTimeout = 60_000;

    private const string LibrarySource = """
        using System;

        namespace HelperLib4095;

        [AttributeUsage(AttributeTargets.Class)]
        public sealed class MarkerAttribute : Attribute
        {
            public MarkerAttribute(Type value)
            {
                Value = value;
            }

            public Type Value { get; }
        }

        public sealed record ExternalData(int Value);

        public static class Probe
        {
            public static string Describe(Type target)
            {
                var marker = (MarkerAttribute)Attribute.GetCustomAttribute(
                    target,
                    typeof(MarkerAttribute))!;
                return DescribeType(marker.Value);
            }

            private static string DescribeType(Type type)
            {
                if (!type.IsGenericType)
                {
                    return (type.FullName ?? type.Name)
                        + "@"
                        + type.Assembly.GetName().Name;
                }

                var definition = type.GetGenericTypeDefinition();
                var arguments = Array.ConvertAll(type.GetGenericArguments(), DescribeType);
                return (definition.FullName ?? definition.Name)
                    + "@"
                    + definition.Assembly.GetName().Name
                    + "["
                    + string.Join(",", arguments)
                    + "]";
            }
        }
        """;

    private const string Source = """
        package P
        import System
        import System.Collections.Generic
        import HelperLib4095

        enum Status {
            Active,
            Retired
        }

        class Box[T] {
            prop Value T
        }

        interface Holder[T] {
            func Get() T;
        }

        delegate Receiver[T](value T);

        delegate Mapper[U](value U) int32;

        class Outer[T] {
            enum Kind {
                First,
                Second
            }

            class Inner {
                prop V T
            }

            class GenericInner[U] {
                prop OuterValue T
                prop OwnValue U
            }

            class Middle[U] {
                class Deep {
                    prop OuterValue T
                    prop MiddleValue U
                }
            }
        }

        @Marker(typeof(Outer[Status].Inner))
        class ExactTarget {
        }

        @Marker(typeof(Outer[Status].Kind))
        class EnumTarget {
        }

        @Marker(typeof(Outer[Status].GenericInner[Outer[Status].Kind]))
        class EnumArgumentTarget {
        }

        @Marker(typeof(Outer[Status].GenericInner[string]))
        class OwnGenericTarget {
        }

        @Marker(typeof(Outer[Status].Middle[string].Deep))
        class DeepTarget {
        }

        @Marker(typeof(Outer[Box[Status]].Inner))
        class ConstructedSourceArgumentTarget {
        }

        @Marker(typeof(Outer[List[Status]].Inner))
        class ConstructedImportedArgumentTarget {
        }

        @Marker(typeof(Outer[Holder[Status]].Inner))
        class ConstructedInterfaceArgumentTarget {
        }

        @Marker(typeof(Outer[Receiver[Status]].Inner))
        class ConstructedDelegateArgumentTarget {
        }

        @Marker(typeof(List[Status]))
        class DirectImportedGenericTarget {
        }

        @Marker(typeof(Outer[Box[int32?]].Inner))
        class NullableValueArgumentTarget {
        }

        @Marker(typeof(Outer[List[Status]?].Inner))
        class NullableReferenceArgumentTarget {
        }

        @Marker(typeof(Outer[ExternalData].Inner))
        class ImportedSemanticAggregateArgumentTarget {
        }

        @Marker(typeof(Box[_]))
        class OpenSourceDefinitionTarget {
        }

        @Marker(typeof(Holder[_]))
        class OpenInterfaceDefinitionTarget {
        }

        @Marker(typeof(Mapper[_]))
        class OpenDelegateDefinitionTarget {
        }

        @Marker(typeof(List[_]))
        class OpenImportedDefinitionTarget {
        }

        @Marker(typeof(Outer[_].GenericInner[_]))
        class OpenNestedGenericDefinitionTarget {
        }

        @Marker(typeof(Outer[_].Inner))
        class OpenNestedDefinitionTarget {
        }

        Console.WriteLine(Probe.Describe(typeof(ExactTarget)))
        Console.WriteLine(Probe.Describe(typeof(EnumTarget)))
        Console.WriteLine(Probe.Describe(typeof(EnumArgumentTarget)))
        Console.WriteLine(Probe.Describe(typeof(OwnGenericTarget)))
        Console.WriteLine(Probe.Describe(typeof(DeepTarget)))
        Console.WriteLine(Probe.Describe(typeof(ConstructedSourceArgumentTarget)))
        Console.WriteLine(Probe.Describe(typeof(ConstructedImportedArgumentTarget)))
        Console.WriteLine(Probe.Describe(typeof(ConstructedInterfaceArgumentTarget)))
        Console.WriteLine(Probe.Describe(typeof(ConstructedDelegateArgumentTarget)))
        Console.WriteLine(Probe.Describe(typeof(DirectImportedGenericTarget)))
        Console.WriteLine(Probe.Describe(typeof(NullableValueArgumentTarget)))
        Console.WriteLine(Probe.Describe(typeof(NullableReferenceArgumentTarget)))
        Console.WriteLine(Probe.Describe(typeof(ImportedSemanticAggregateArgumentTarget)))
        Console.WriteLine(Probe.Describe(typeof(OpenSourceDefinitionTarget)))
        Console.WriteLine(Probe.Describe(typeof(OpenInterfaceDefinitionTarget)))
        Console.WriteLine(Probe.Describe(typeof(OpenDelegateDefinitionTarget)))
        Console.WriteLine(Probe.Describe(typeof(OpenImportedDefinitionTarget)))
        Console.WriteLine(Probe.Describe(typeof(OpenNestedGenericDefinitionTarget)))
        Console.WriteLine(Probe.Describe(typeof(OpenNestedDefinitionTarget)))
        """;

    private static readonly string[] ExpectedDescriptions =
    {
        "P.Outer`1+Inner@P[P.Status@P]",
        "P.Outer`1+Kind@P[P.Status@P]",
        "P.Outer`1+GenericInner`1@P[P.Status@P,P.Outer`1+Kind@P[P.Status@P]]",
        "P.Outer`1+GenericInner`1@P[P.Status@P,System.String@System.Private.CoreLib]",
        "P.Outer`1+Middle`1+Deep@P[P.Status@P,System.String@System.Private.CoreLib]",
        "P.Outer`1+Inner@P[P.Box`1@P[P.Status@P]]",
        "P.Outer`1+Inner@P[System.Collections.Generic.List`1@System.Private.CoreLib[P.Status@P]]",
        "P.Outer`1+Inner@P[P.Holder`1@P[P.Status@P]]",
        "P.Outer`1+Inner@P[P.Receiver`1@P[P.Status@P]]",
        "System.Collections.Generic.List`1@System.Private.CoreLib[P.Status@P]",
        "P.Outer`1+Inner@P[P.Box`1@P[System.Nullable`1@System.Private.CoreLib[System.Int32@System.Private.CoreLib]]]",
        "P.Outer`1+Inner@P[System.Collections.Generic.List`1@System.Private.CoreLib[P.Status@P]]",
        "P.Outer`1+Inner@P[HelperLib4095.ExternalData@HelperLib4095]",
        "P.Box`1@P[T@P]",
        "P.Holder`1@P[T@P]",
        "P.Mapper`1@P[U@P]",
        "System.Collections.Generic.List`1@System.Private.CoreLib[T@System.Private.CoreLib]",
        "P.Outer`1+GenericInner`1@P[T@P,U@P]",
        "P.Outer`1+Inner@P[T@P]",
    };

    [Fact]
    public void NestedTypesInGenericOuters_ReifyWithEnclosingArgumentsAndEmittedArity()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4095_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var log = Compile(tempDir, Source, appPath, libPath);

            Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal);
            Assert.Empty(ErrorIds(log));
            Assert.True(File.Exists(appPath), "sample must compile. Log:\n" + log);

            IlVerifier.Verify(appPath, new[] { libPath });
            AssertMetadataNames(appPath);
            Assert.Equal(
                ExpectedDescriptions,
                ReadAttributeTypes(
                    appPath,
                    libPath,
                    "ExactTarget",
                    "EnumTarget",
                    "EnumArgumentTarget",
                    "OwnGenericTarget",
                    "DeepTarget",
                    "ConstructedSourceArgumentTarget",
                    "ConstructedImportedArgumentTarget",
                    "ConstructedInterfaceArgumentTarget",
                    "ConstructedDelegateArgumentTarget",
                    "DirectImportedGenericTarget",
                    "NullableValueArgumentTarget",
                    "NullableReferenceArgumentTarget",
                    "ImportedSemanticAggregateArgumentTarget",
                    "OpenSourceDefinitionTarget",
                    "OpenInterfaceDefinitionTarget",
                    "OpenDelegateDefinitionTarget",
                    "OpenImportedDefinitionTarget",
                    "OpenNestedGenericDefinitionTarget",
                    "OpenNestedDefinitionTarget"));

            var (exit, output) = RunDotnet(appPath, libPath);
            Assert.True(exit == 0, $"sample must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(
                ExpectedDescriptions,
                output.Split('\n')
                    .Select(line => line.TrimEnd('\r'))
                    .Where(line => line.Length > 0));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void OpenTypeParameterOperands_ReportGS0202AndDoNotEmit()
    {
        const string source = """
            package P
            import System
            import System.Collections.Generic
            import HelperLib4095

            delegate Empty[U]();

            class Box[T] {
            }

            interface Holder[T] {
            }

            class Outer[T] {
                class Inner {
                }

                enum Kind {
                    First,
                    Second
                }
            }

            @Marker(typeof(Box[T]))
            class OpenSourceArgumentTarget[T] {
            }

            @Marker(typeof(Holder[T]))
            class OpenInterfaceArgumentTarget[T] {
            }

            @Marker(typeof(Empty[T]))
            class OpenDelegateArgumentTarget[T] {
            }

            @Marker(typeof(Outer[Empty[T]].Inner))
            class OpenNestedDelegateArgumentTarget[T] {
            }

            @Marker(typeof(Outer[T].Inner))
            class OpenNestedArgumentTarget[T] {
            }

            @Marker(typeof(Outer[T].Kind))
            class OpenNestedEnumArgumentTarget[T] {
            }

            @Marker(typeof(List[T]))
            class OpenImportedArgumentTarget[T] {
            }

            Console.WriteLine("unreachable")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4095_open_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "P.dll");
            var log = Compile(tempDir, source, appPath, libPath);

            Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal);
            Assert.Equal(
                new[] { "GS0202", "GS0202", "GS0202", "GS0202", "GS0202", "GS0202", "GS0202" },
                ErrorIds(log));
            Assert.False(File.Exists(appPath), "invalid open type operands must not emit an assembly.");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static void AssertMetadataNames(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();

        AssertType(reader, "Outer`1", genericParameterCount: 1);
        AssertType(reader, "Kind", genericParameterCount: 1);
        AssertType(reader, "Inner", genericParameterCount: 1);
        AssertType(reader, "GenericInner`1", genericParameterCount: 2);
        AssertType(reader, "Middle`1", genericParameterCount: 2);
        AssertType(reader, "Deep", genericParameterCount: 2);
    }

    private static void AssertType(MetadataReader reader, string name, int genericParameterCount)
    {
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(definition => reader.GetString(definition.Name) == name);
        Assert.Equal(genericParameterCount, type.GetGenericParameters().Count);
    }

    private static string[] ReadAttributeTypes(
        string assemblyPath,
        string libPath,
        params string[] targetNames)
    {
        var paths = new List<string>(TrustedPlatformAssemblies())
        {
            assemblyPath,
            libPath,
        };

        using var context = new MetadataLoadContext(new PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)));
        var assembly = context.LoadFromAssemblyPath(assemblyPath);
        return targetNames.Select(name =>
        {
            var target = assembly.GetTypes().Single(type => type.Name == name);
            var marker = target.GetCustomAttributesData()
                .Single(attribute => attribute.AttributeType.FullName == "HelperLib4095.MarkerAttribute");
            return Describe((Type)marker.ConstructorArguments[0].Value!);
        }).ToArray();
    }

    private static string Describe(Type type)
    {
        if (!type.IsGenericType)
        {
            return (type.FullName ?? type.Name) + "@" + type.Assembly.GetName().Name;
        }

        var definition = type.GetGenericTypeDefinition();
        var arguments = type.GetGenericArguments().Select(Describe);
        return (definition.FullName ?? definition.Name)
            + "@"
            + definition.Assembly.GetName().Name
            + "["
            + string.Join(",", arguments)
            + "]";
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();
        var compilation = CSharpCompilation.Create(
            "HelperLib4095",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var libPath = Path.Combine(tempDir, "HelperLib4095.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "helper library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return libPath;
    }

    private static string Compile(string dir, string source, string outPath, string libPath)
    {
        var sourcePath = Path.Combine(dir, "App.gs");
        File.WriteAllText(sourcePath, source);
        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/reference:" + libPath,
        };
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return stdout.ToString() + stderr.ToString();
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath, string libPath)
    {
        var directory = Path.GetDirectoryName(assemblyPath) ?? ".";
        var sideBySide = Path.Combine(directory, Path.GetFileName(libPath));
        if (!File.Exists(sideBySide))
        {
            File.Copy(libPath, sideBySide);
        }

        var startInfo = new ProcessStartInfo("dotnet", "\"" + assemblyPath + "\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = directory,
        };
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("could not start dotnet");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult());
    }

    private static string[] ErrorIds(string log)
        => Regex.Matches(log, @"error (GS[0-9]{4})")
            .Select(match => match.Groups[1].Value)
            .ToArray();

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(tpa)
            ? Enumerable.Empty<string>()
            : tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
