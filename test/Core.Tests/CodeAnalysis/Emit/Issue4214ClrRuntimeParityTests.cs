// <copyright file="Issue4214ClrRuntimeParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue4214ClrRuntimeParityTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AssemblyIdentity_UsesDeclaredAssemblyVersionInsteadOfProductVersion(bool declaredVersion)
    {
        var source = (declaredVersion
            ? "@assembly: System.Reflection.AssemblyVersion(\"2.3.0.0\")\n"
            : string.Empty) + "class Identity {}";
        using var stream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(source)) { IsLibrary = true };
        var result = compilation.Emit(
            stream, pdbStream: null, refStream: null,
            assemblyName: "Identity", assemblyVersion: "2.3.57-beta+abcdef");
        Assert.True(result.Success, string.Join("; ", result.Diagnostics));
        stream.Position = 0;
        using var pe = new PEReader(stream);
        Assert.Equal(
            declaredVersion ? "2.3.0.0" : "2.3.57.0",
            pe.GetMetadataReader().GetAssemblyDefinition().Version.ToString());
    }

    [Fact]
    public void FunctionType_MetadataRetainsNestedNullableSlots()
    {
        var nullableString = NullableTypeSymbol.Get(TypeSymbol.String);
        var function = FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(nullableString), nullableString);
        Assert.Equal(new byte[] { 1, 2, 2 }, NullableFlagsBuilder.Build(function));
        Assert.Equal(new byte[] { 2, 2, 2 }, NullableFlagsBuilder.Build(NullableTypeSymbol.Get(function)));
        var action = FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(nullableString), TypeSymbol.Void);
        Assert.Equal(new byte[] { 1, 2 }, NullableFlagsBuilder.Build(action));
        var nonNull = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.String), TypeSymbol.Bool);
        Assert.Equal(new byte[] { 1, 1 }, NullableFlagsBuilder.Build(nonNull));
        var parameter = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var symbolic = FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(parameter), TypeSymbol.Bool);
        Assert.Null(symbolic.ClrType);
        Assert.Equal(new byte[] { 1 }, NullableFlagsBuilder.Build(symbolic));
    }

    [Fact]
    public void InterpolatedFieldPostIncrement_UsesOriginalValues()
    {
        var result = EmittedOracle.Evaluate("""
            class Counter {
                private var ordinal int32
                func Next() string -> "${ordinal++}:${ordinal++}:${ordinal}"
            }
            Counter().Next()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("0:1:2", result.Value);
    }

    [Fact]
    public void NestedAsyncClosure_PreservesCapturedUsingLocal()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Threading
            import System.Threading.Tasks
            async func Run() int32 {
                using let ready = CountdownEvent(1)
                let outer = async func () {
                    ready.Signal()
                    await Task.Run(() -> ready.Wait())
                }
                await outer()
                return 42
            }
            Run().GetAwaiter().GetResult()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }
}
