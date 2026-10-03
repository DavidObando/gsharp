// <copyright file="Issue4675RecordPrimaryConstructorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue4675RecordPrimaryConstructorEmitTests
{
    [Fact]
    public void MissingPrimaryConstructorStorage_FailsFast()
    {
        var compilation = new Compilation(SyntaxTree.Parse("data struct Item(Value int32)"));
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation));
        StructSymbol type = Assert.Single(compilation.GlobalScope.Structs);
        type.SetProperties(ImmutableArray<PropertySymbol>.Empty);

        var exception = Assert.Throws<InvalidOperationException>(
            () => ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(type, "Value", out _));
        Assert.Contains("Value", exception.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    [InlineData("open data class")]
    public void ComputedPositionalProperty_DoesNotRequireAStore(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            KIND Item(Value int32) {
                private let Storage int32 = Value + 1
                public prop Value int32 -> Storage
            }
            Item(41).Value
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void PlannedPrimaryConstructor_StoresParametersBeforeInitializers()
    {
        var result = EmittedOracle.Evaluate("""
            data struct Item[T](Value T) {
                private let Storage T = Value
                private let Reference readonly managed[T] = readonly managed(Value)
                public func Read() T { return *Reference }
                public func ReadStorage() T { return Storage }
            }
            let item = Item[int32](41)
            item.Value + item.Read() + item.ReadStorage()
            """, new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(123, result.Value);
    }

    [Fact]
    public void DuplicatePositionalProperty_RetainsDuplicateDiagnostic()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            data struct Item(Value int32) {
                public prop Value int32 { get; }
                public prop Value int32 { get; }
            }
            """));
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        var duplicate = Assert.Single(diagnostics, diagnostic => diagnostic.Id == "GS0102");
        Assert.Equal(3, duplicate.Location.StartLine + 1);
    }

    [Fact]
    public void EquatableOfDifferentGenericInstantiation_StillRequiresImplementation()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            data struct Item[T](Value T) : IEquatable[Item[int32]]
            """));
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        var missing = Assert.Single(diagnostics, diagnostic => diagnostic.Id == "GS0187");
        Assert.Equal(0, missing.Location.StartLine);
    }

    [Theory]
    [InlineData("T", false)]
    [InlineData("int32", true)]
    public void NestedRecordEquatableContract_PreservesEnclosingTypeArguments(string argument, bool requiresImplementation)
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            open class Outer[T] {
                public data class Item(Value int32) : IEquatable[Outer[ARGUMENT].Item]
            }
            """.Replace("ARGUMENT", argument, StringComparison.Ordinal)));
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        if (requiresImplementation)
        {
            var missing = Assert.Single(diagnostics, diagnostic => diagnostic.Id == "GS0187");
            Assert.Equal(1, missing.Location.StartLine);
        }
        else
        {
            Assert.Empty(diagnostics);
        }
    }
}
