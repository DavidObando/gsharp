// <copyright file="Issue2519SourceClassConstraintOrderingEmitTests.cs" company="GSharp">
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

/// <summary>Runtime and metadata regressions for issue #2519.</summary>
public sealed class Issue2519SourceClassConstraintOrderingEmitTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SourceClassConstraint_InEitherFileOrder_PreservesMetadataDispatchAndMembers(bool reverse)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2519_").FullName;
        try
        {
            var sources = WriteSources(directory);
            if (reverse)
            {
                sources.Reverse();
            }

            var assemblyPath = Path.Combine(directory, "Issue2519.dll");
            var args = new List<string>
            {
                "/out:" + assemblyPath,
                "/target:library",
                "/targetframework:net10.0",
            };
            args.AddRange(sources);

            Assert.Equal(0, Program.Main(args.ToArray()));
            IlVerifier.Verify(assemblyPath, additionalReferences: TrustedPlatformAssemblies());
            VerifyCSharpConsumer(assemblyPath);

            var loadContext = new AssemblyLoadContext("Issue2519", isCollectible: true);
            try
            {
                var assembly = loadContext.LoadFromAssemblyPath(assemblyPath);
                var holderDefinition = assembly.GetType("P.Audio.Holder2519`1", throwOnError: true)!;
                var entryType = assembly.GetType("P.Entry2519", throwOnError: true)!;
                var concreteType = assembly.GetType("P.Concrete2519", throwOnError: true)!;
                var typeParameter = Assert.Single(holderDefinition.GetGenericArguments());
                Assert.Equal(entryType, Assert.Single(typeParameter.GetGenericParameterConstraints()));

                var holderType = holderDefinition.MakeGenericType(concreteType);
                var holder = Activator.CreateInstance(holderType);
                var concrete = Activator.CreateInstance(concreteType);
                var subscriptions = 0;
                var handler = new Action(() => subscriptions++);
                holderType.GetMethod("Subscribe")!.Invoke(holder, new[] { concrete, handler });
                concreteType.GetMethod("Raise")!.Invoke(concrete, null);

                Assert.Equal(10, holderType.GetMethod("Read")!.Invoke(holder, new[] { concrete }));
                Assert.Same(concrete, holderType.GetMethod("Upcast")!.Invoke(holder, new[] { concrete }));
                Assert.Equal(1, subscriptions);
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

    private static List<string> WriteSources(string directory)
    {
        var sources = new[]
        {
            ("AHolder.gs", """
                package P.Audio
                import P
                import System
                public class Holder2519[T Entry2519] {
                    public func Read(value T) int32 ->
                        value.Count + value.SamplesInFrame + value.Inherited() + value.VirtualValue()
                    public func Upcast(value T) Entry2519 -> value
                    public func Subscribe(value T, handler Action) {
                        value.Changed += handler
                    }
                }
                """),
            ("ZEntry.gs", """
                package P
                import System
                public open class Root2519 {
                    public var SamplesInFrame int32
                    public func Inherited() int32 -> 3
                    public event Changed Action
                    public func Raise() {
                        Changed()
                    }
                }
                public open class Entry2519 : Root2519 {
                    public prop Count int32 -> 2
                    public open func VirtualValue() int32 -> 4
                }
                public class Concrete2519 : Entry2519 {
                    public override func VirtualValue() int32 -> 5
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
            using P;
            using P.Audio;

            public static class Consumer2519
            {
                public static int Run()
                {
                    var value = new Concrete2519();
                    var holder = new Holder2519<Concrete2519>();
                    holder.Subscribe(value, () => { });
                    Entry2519 upcast = holder.Upcast(value);
                    return holder.Read(value) + (ReferenceEquals(value, upcast) ? 0 : 100);
                }
            }
            """;
        var compilation = CSharpCompilation.Create(
            "Issue2519.Consumer",
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
