// <copyright file="InterfaceAdaptationReviewTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public sealed class InterfaceAdaptationReviewTests
{
    [Fact]
    public void RichBaseArgumentHeapRetentionRejectsRefAndRefLikeShapes()
    {
        var refConstructor = typeof(RefConstructorBase).GetConstructor(
            new[] { typeof(int).MakeByRefType() });
        Assert.NotNull(refConstructor);
        var refInitializer = new BaseConstructorInitializer(
            ImmutableArray<BoundExpression>.Empty,
            refConstructor,
            ImmutableArray.Create(RefKind.Ref));
        Assert.True(GSharp.Core.CodeAnalysis.Binding.Binder.IsUnsupportedRichBaseArgument(
            refInitializer,
            argumentIndex: 0,
            TypeSymbol.Int32));

        var valueConstructor = typeof(ValueConstructorBase).GetConstructor(new[] { typeof(int) });
        Assert.NotNull(valueConstructor);
        var valueInitializer = new BaseConstructorInitializer(
            ImmutableArray<BoundExpression>.Empty,
            valueConstructor);
        Assert.False(GSharp.Core.CodeAnalysis.Binding.Binder.IsUnsupportedRichBaseArgument(
            valueInitializer,
            argumentIndex: 0,
            TypeSymbol.Int32));
        Assert.True(GSharp.Core.CodeAnalysis.Binding.Binder.IsUnsupportedRichBaseArgument(
            valueInitializer,
            argumentIndex: 0,
            TypeSymbol.FromClrType(typeof(ReadOnlySpan<int>))));
    }

    [Fact]
    public void BodiesWithRichOrAdapterSynthesisBypassIncrementalBodyReuse()
    {
        var tree = SyntaxTree.Parse(
            """
            package AdapterCache
            interface Reader { func Read() int32; }
            class Source(Value int32) { func Read() int32 -> Value }
            func Build(value int32) Reader {
                let rich = object : Reader {
                    func Read() int32 -> value
                }
                return adapt[Reader](Source(rich.Read()))
            }
            """);
        var global = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree));
        var cache = new BoundBodyCache();
        var first = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(global, references: null, cache);
        var second = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(global, references: null, cache);
        var build = global.Functions.Single(function => function.Name == "Build");
        Assert.NotSame(first.Functions[build], second.Functions[build]);
        Assert.True(cache.Hits > 0);
        AssertSyntheticBodiesRegistered(first);
        AssertSyntheticBodiesRegistered(second);
    }

    [Fact]
    public void SourceInitOnlyMismatchIsPartOfTheStructuralPropertyContract()
    {
        var tree = SyntaxTree.Parse(
            """
            package InitContract
            interface Target { prop Value int32 { get; set; } }
            class Source { prop Value int32 { get; init; } }
            func Bad() { let value = adapt[Target](Source()) }
            """);
        var compilation = new Compilation(tree) { IsLibrary = true };
        using var pe = new MemoryStream();
        var result = compilation.Emit(pe);
        var target = Assert.Single(compilation.GlobalScope.Interfaces, symbol => symbol.Name == "Target");
        var source = Assert.Single(compilation.GlobalScope.Structs, symbol => symbol.Name == "Source");
        Assert.False(Assert.Single(target.Properties).IsInitOnly);
        Assert.True(Assert.Single(source.Properties).IsInitOnly);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0606");
    }

    [Fact]
    public void AdapterNamesRemainUniqueAcrossBindingPhasesFilesPackagesAndRepeatedEmit()
    {
        var trees = new[]
        {
            SyntaxTree.Parse(SourceText.From(
                """
                package AdapterNames
                public interface Reader { func Read() int32; }
                public class Source(Value int32) { public func Read() int32 -> Value }
                let top = adapt[Reader](Source(1))
                """,
                "top.gs")),
            SyntaxTree.Parse(SourceText.From(
                """
                package AdapterNames
                public func Build() Reader { return adapt[Reader](Source(2)) }
                """,
                "body.gs")),
            SyntaxTree.Parse(SourceText.From(
                """
                package AdapterNames.Consumer
                import AdapterNames
                public func BuildOther() Reader { return adapt[Reader](Source(3)) }
                """,
                "other.gs")),
        };
        var compilation = new Compilation(trees);
        using var first = new MemoryStream();
        using var second = new MemoryStream();
        var firstResult = compilation.Emit(first);
        var secondResult = compilation.Emit(second);
        Assert.True(firstResult.Success, string.Join("; ", firstResult.Diagnostics.Select(diagnostic => diagnostic.Message)));
        Assert.True(secondResult.Success, string.Join("; ", secondResult.Diagnostics.Select(diagnostic => diagnostic.Message)));
        Assert.Equal(first.ToArray(), second.ToArray());

        first.Position = 0;
        var context = new AssemblyLoadContext(nameof(AdapterNamesRemainUniqueAcrossBindingPhasesFilesPackagesAndRepeatedEmit), isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(first);
            var adapters = assembly.GetTypes()
                .Where(type => type.Name.StartsWith("<>Adapter", StringComparison.Ordinal))
                .ToArray();
            Assert.Equal(3, adapters.Length);
            Assert.Equal(adapters.Length, adapters.Select(type => type.FullName).Distinct(StringComparer.Ordinal).Count());
            Assert.Equal(
                new[] { "<>Adapter0", "<>Adapter1", "<>Adapter2" },
                adapters.Select(type => type.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray());
        }
        finally
        {
            context.Unload();
        }
    }

    private static void AssertSyntheticBodiesRegistered(BoundProgram program)
    {
        var syntheticTypes = program.Structs
            .Where(type => type.Name.StartsWith("<>AnonClass", StringComparison.Ordinal)
                || type.Name.StartsWith("<>Adapter", StringComparison.Ordinal))
            .ToArray();
        Assert.Equal(2, syntheticTypes.Length);
        foreach (var method in syntheticTypes.SelectMany(type => type.Methods))
        {
            Assert.True(program.Functions.ContainsKey(method), method.Name);
        }
    }

    private sealed class RefConstructorBase
    {
        public RefConstructorBase(ref int value)
        {
        }
    }

    private sealed class ValueConstructorBase
    {
        public ValueConstructorBase(int value)
        {
        }
    }
}
