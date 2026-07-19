// <copyright file="Issue2517ConstructedBaseOrderingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Runtime, reflection, C# consumer, and ILVerify coverage for issue #2517.</summary>
public sealed class Issue2517ConstructedBaseOrderingEmitTests
{
    [Fact]
    public void EarlyCrossPackageSignature_PreservesConstructedBaseMetadataAndDispatch()
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2517_").FullName;
        try
        {
            var sources = WriteSources(directory);
            var assemblyPath = Path.Combine(directory, "Issue2517.dll");
            var args = new List<string>
            {
                "/out:" + assemblyPath,
                "/target:library",
                "/targetframework:net10.0",
            };
            args.AddRange(sources);

            var exitCode = Program.Main(args.ToArray());
            Assert.Equal(0, exitCode);
            IlVerifier.Verify(assemblyPath, additionalReferences: TrustedPlatformAssemblies());
            VerifyCSharpConsumer(assemblyPath);

            var loadContext = new AssemblyLoadContext("Issue2517", isCollectible: true);
            try
            {
                var assembly = loadContext.LoadFromAssemblyPath(assemblyPath);
                var derived = assembly.GetType("P.Audio.Derived2517", throwOnError: true)!;
                var middle = assembly.GetType("P.Middle2517`2", throwOnError: true)!;
                var baseType = assembly.GetType("P.Base2517`1", throwOnError: true)!;

                Assert.Equal(middle, derived.BaseType!.GetGenericTypeDefinition());
                Assert.Equal(baseType, derived.BaseType.BaseType!.GetGenericTypeDefinition());
                Assert.Equal(
                    "P.Entry2517",
                    Assert.Single(derived.BaseType.BaseType.GenericTypeArguments).FullName);

                var sizeGetter = derived.GetProperty(
                    "Size",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)!.GetMethod!;
                Assert.Equal(
                    baseType,
                    sizeGetter.GetBaseDefinition().DeclaringType!.GetGenericTypeDefinition());

                var instance = Activator.CreateInstance(derived);
                var read = derived.GetMethod("Read", BindingFlags.Instance | BindingFlags.Public)!;
                Assert.Equal(101, read.Invoke(instance, null));
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static IReadOnlyList<string> WriteSources(string directory)
    {
        var sources = new[]
        {
            ("0Early.gs", """
                package Other
                import P
                public class Early2517 {
                    public func Get() Middle2517[Entry2517,Entry2517]? -> default(Middle2517[Entry2517,Entry2517]?)
                }
                """),
            ("ADerived.gs", """
                package P.Audio
                import P
                public open class Derived2517 : Middle2517[Entry2517,Entry2517] {
                    public open override prop Size int32 -> 100
                    public func Read() int32 -> Size + Inherited()
                }
                """),
            ("Entry.gs", """
                package P
                public class Entry2517 { }
                """),
            ("YMiddle.gs", """
                package P
                public open class Middle2517[TInput,TOutput] : Base2517[TInput] { }
                """),
            ("ZBase.gs", """
                package P
                public open class Base2517[T] {
                    public open prop Size int32 { get; }
                    protected func Inherited() int32 -> 1
                }
                """),
        };

        var paths = new List<string>(sources.Length);
        foreach (var (name, source) in sources)
        {
            var path = Path.Combine(directory, name);
            File.WriteAllText(path, source);
            paths.Add(path);
        }

        return paths;
    }

    private static void VerifyCSharpConsumer(string assemblyPath)
    {
        const string source = """
            using P.Audio;

            public static class Consumer2517
            {
                public static int Run() => new Derived2517().Read();
            }
            """;
        var compilation = CSharpCompilation.Create(
            "Issue2517.Consumer",
            new[] { CSharpSyntaxTree.ParseText(source) },
            TrustedPlatformAssemblies()
                .Select(path => MetadataReference.CreateFromFile(path))
                .Append(MetadataReference.CreateFromFile(assemblyPath)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string[] TrustedPlatformAssemblies()
        => ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))!
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
}
