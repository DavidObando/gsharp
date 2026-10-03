// <copyright file="Issue4731InheritedClrInterfaceConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4731InheritedClrInterfaceConversionEmitTests
{
    private const string ContractSource = """
        #nullable enable
        namespace Issue4731.Contracts;

        public interface IRenderable { int Read(); }
        public abstract class Renderable : IRenderable
        {
            protected abstract int Measure();
            public int Read() => Measure();
        }

        public interface ISource<out T> { int ReadCode(); }
        public class Reordered<TFirst, TSecond> : ISource<TSecond>
        {
            public int ReadCode() => 31;
        }

        public interface ISink<in T> { int Take(T value); }
        public class Sink<T> : ISink<T>
        {
            public int Take(T value) => 29;
        }

        public interface IInvariant<T> { int ReadCode(); }
        public class Invariant<T> : IInvariant<T>
        {
            public int ReadCode() => 37;
        }
        """;

    [Fact]
    public void SealedRenderable_ImplicitCheckedAndTransitiveUpcasts_PreserveIdentityAndDispatch()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue4731.Consumer
            import System
            import Issue4731.Contracts

            public class Dock : Renderable {
                private let height int32 = 17
                protected override func Measure() int32 -> height
            }
            open class Mid : Renderable {
                protected override func Measure() int32 -> 23
            }
            class Deep : Mid {}
            class Listed : Renderable, IRenderable {
                protected override func Measure() int32 -> 19
            }

            public func NullableCast(value Dock?) IRenderable -> cast[IRenderable](value)

            public func Probe() int32 {
                let dock = Dock()
                var implicitValue IRenderable = dock
                let checkedValue = cast[IRenderable](dock)
                let deep = Deep()
                var inheritedValue IRenderable = deep
                let checkedInherited = cast[IRenderable](deep)
                var listed IRenderable = Listed()
                var importedBase Renderable = dock
                if !Object.ReferenceEquals(dock, implicitValue)
                    || !Object.ReferenceEquals(dock, checkedValue)
                    || !Object.ReferenceEquals(deep, inheritedValue)
                    || !Object.ReferenceEquals(deep, checkedInherited)
                    || !Object.ReferenceEquals(dock, importedBase) {
                    return -1
                }
                return implicitValue.Read() + checkedValue.Read()
                    + inheritedValue.Read() + listed.Read()
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });

        var loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath);
        var assembly = loaded[1];
        var dock = Assert.Single(assembly.GetTypes(), type => type.Name == "Dock");
        Assert.True(dock.IsSealed);
        Assert.Contains(dock.GetInterfaces(), type => type.FullName == "Issue4731.Contracts.IRenderable");
        Assert.Equal(76, FindMethod(assembly, "Probe").Invoke(null, null));
        Assert.Null(FindMethod(assembly, "NullableCast").Invoke(null, new object[] { null }));
    }

    [Fact]
    public void GenericOwnerSubstitutionAndVariance_PreserveIdentityAndInheritedDispatch()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue4731.Generic
            import System
            import Issue4731.Contracts

            class Item {}
            open class Mid[A, B] : Reordered[B, A] {}
            class Leaf[T] : Mid[T, int32] {}
            class SinkLeaf : Sink[object] {}
            class InvariantLeaf : Invariant[Item] {}

            func Convert[T](value Leaf[T]) ISource[T] -> value
            func Checked[T](value Leaf[T]) ISource[T] -> cast[ISource[T]](value)

            public func Probe() int32 {
                let leaf = Leaf[string]()
                let exact = Convert(leaf)
                var covariant ISource[object] = leaf
                let checkedCovariant = cast[ISource[object]](leaf)
                let local = Leaf[Item]()
                let localView = Checked(local)
                var nullableValue ISource[int32?] = Leaf[int32?]()
                let sink = SinkLeaf()
                var contravariant ISink[string] = sink
                let invariant = InvariantLeaf()
                var invariantView IInvariant[Item] = invariant
                if !Object.ReferenceEquals(leaf, exact)
                    || !Object.ReferenceEquals(leaf, covariant)
                    || !Object.ReferenceEquals(leaf, checkedCovariant)
                    || !Object.ReferenceEquals(local, localView)
                    || !Object.ReferenceEquals(sink, contravariant)
                    || !Object.ReferenceEquals(invariant, invariantView) {
                    return -1
                }
                return exact.ReadCode() + covariant.ReadCode()
                    + checkedCovariant.ReadCode() + localView.ReadCode()
                    + nullableValue.ReadCode() + contravariant.Take("value")
                    + invariantView.ReadCode()
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });

        var loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath);
        Assert.Equal(221, FindMethod(loaded[1], "Probe").Invoke(null, null));
    }

    [Theory]
    [InlineData("class Leaf {}", "Leaf", "IRenderable", "cast[IRenderable](value)")]
    [InlineData("class Leaf : Reordered[int32, int32] {}", "Leaf", "ISource[object]", "value")]
    [InlineData("class Item {}\nclass Other {}\nclass Leaf : Invariant[Item] {}", "Leaf", "IInvariant[Other]", "value")]
    public void UnrelatedSealedAndInvalidGenericConversions_AreRejected(
        string declarations,
        string sourceType,
        string targetType,
        string expression)
    {
        using var fixture = new Fixture();
        var result = fixture.Compile($"""
            package Issue4731.Rejected
            import Issue4731.Contracts
            {declarations}
            func Convert(value {sourceType}) {targetType} -> {expression}
            """);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("error GS0155:", result.Output, StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    private static MethodInfo FindMethod(Assembly assembly, string name) =>
        Assert.Single(
            assembly.GetTypes().SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static)),
            method => method.Name == name);

    private sealed class Fixture : IDisposable
    {
        private readonly string directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4731InheritedClrInterfaceConversionEmitTests),
            Guid.NewGuid().ToString("N"));

        public Fixture()
        {
            Directory.CreateDirectory(directory);
            AssemblyPath = Path.Combine(directory, "Issue4731.Contracts.dll");
            var compilation = CSharpCompilation.Create(
                "Issue4731.Contracts",
                new[] { CSharpSyntaxTree.ParseText(ContractSource) },
                ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(path => MetadataReference.CreateFromFile(path)),
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using var stream = File.Create(AssemblyPath);
            var result = compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        public string AssemblyPath { get; }

        public (int ExitCode, string Output, string AssemblyPath) Compile(string source)
        {
            var sourcePath = Path.Combine(directory, "Consumer.gs");
            var outputPath = Path.Combine(directory, "Consumer.dll");
            File.WriteAllText(sourcePath, source);
            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            int exitCode;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/target:library",
                    "/targetframework:net10.0",
                    "/r:" + AssemblyPath,
                    "/out:" + outputPath,
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            return (exitCode, stdout.ToString() + stderr.ToString(), outputPath);
        }

        public void Dispose() => Directory.Delete(directory, recursive: true);
    }
}
