// <copyright file="Issue4474MemberAccessibilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4474: composite literals check the selected property's setter
/// accessibility, and source indexer reads and writes check the accessor they
/// invoke. Inaccessible accessors are diagnosed before emit.
/// </summary>
public sealed class Issue4474MemberAccessibilityTests
{
    [Theory]
    [InlineData("private", "GS0472")]
    [InlineData("protected", "GS0379")]
    public void CompositeLiteral_RestrictedSetter_FromUnrelatedClass_IsInaccessible(
        string accessibility,
        string expectedId)
    {
        var source = $$"""
            open class Source {
                prop P int32 { get; {{accessibility}} set; }
            }
            class Other {
                func Make() Source -> Source{ P: 1 }
            }
            """;

        AssertSingleError(source, expectedId, "P");
    }

    [Theory]
    [InlineData("private", "let value = source[0]", "GS0472")]
    [InlineData("private", "source[0] = 1", "GS0472")]
    [InlineData("protected", "let value = source[0]", "GS0379")]
    [InlineData("protected", "source[0] = 1", "GS0379")]
    public void SourceIndexer_FromUnrelatedClass_IsInaccessible(
        string accessibility,
        string statement,
        string expectedId)
    {
        var source = $$"""
            open class Source {
                {{accessibility}} prop this[i int32] int32 {
                    get -> i
                    set { }
                }
            }
            class Other {
                func Use(source Source) {
                    {{statement}}
                }
            }
            """;

        AssertSingleError(source, expectedId, "source");
    }

    [Theory]
    [InlineData("private", "GS0472")]
    [InlineData("protected", "GS0379")]
    public void SourceIndexer_RestrictedSetter_ReadsButDoesNotWrite(
        string accessibility,
        string expectedId)
    {
        var declaration = $$"""
            open class Source {
                prop this[i int32] int32 {
                    get -> i
                    {{accessibility}} set { }
                }
            }
            """;

        var read = EmittedOracle.Evaluate(declaration + "\nlet value = Source()[0]");
        Assert.Empty(read.Diagnostics.Where(d => d.IsError));
        Assert.Equal(0, read.Value);

        AssertSingleError(declaration + "\nSource()[0] = 1", expectedId, "Source()");
    }

    [Theory]
    [InlineData("private", "GS0472")]
    [InlineData("protected", "GS0379")]
    public void SourceIndexer_RestrictedGetter_WritesButDoesNotRead(
        string accessibility,
        string expectedId)
    {
        var declaration = $$"""
            open class Source {
                prop this[i int32] int32 {
                    {{accessibility}} get -> i
                    set { }
                }
            }
            """;

        var write = EmittedOracle.Evaluate(declaration + "\nSource()[0] = 1");
        Assert.Empty(write.Diagnostics.Where(d => d.IsError));

        AssertSingleError(declaration + "\nlet value = Source()[0]", expectedId, "Source()");
    }

    [Fact]
    public void InaccessibleIndexer_StillBindsIndexAndValueForDiagnostics()
    {
        const string declaration = """
            class Source {
                private prop this[i int32] int32 {
                    get -> i
                    set { }
                }
            }
            """;
        var read = EmittedOracle.Evaluate(declaration + """

            class Other {
                func Use(source Source) {
                    let read = source[missingIndex]
                }
            }
            """).Diagnostics.Where(d => d.IsError).ToArray();
        Assert.Contains(read, d => d.Id == "GS0125" && d.Message.Contains("missingIndex", StringComparison.Ordinal));

        var write = EmittedOracle.Evaluate(declaration + """

            class Other {
                func Use(source Source) {
                    source[missingIndex] = missingValue
                }
            }
            """).Diagnostics.Where(d => d.IsError).ToArray();
        Assert.Single(write, d => d.Id == "GS0472");
        Assert.Contains(write, d => d.Id == "GS0125" && d.Message.Contains("missingIndex", StringComparison.Ordinal));
        Assert.Contains(write, d => d.Id == "GS0125" && d.Message.Contains("missingValue", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("private", "let value = source[0, 1]", "GS0472")]
    [InlineData("protected", "source[0, 1] = 1", "GS0379")]
    public void MultiParameterSourceIndexer_FromUnrelatedClass_IsInaccessible(
        string accessibility,
        string statement,
        string expectedId)
    {
        var source = $$"""
            open class Source {
                {{accessibility}} prop this[row int32, column int32] int32 {
                    get -> row + column
                    set { }
                }
            }
            class Other {
                func Use(source Source) {
                    {{statement}}
                }
            }
            """;

        AssertSingleError(source, expectedId, "source");
    }

    [Theory]
    [InlineData("private", "let value = source[^1]", "GS0472")]
    [InlineData("protected", "source[^1] = 1", "GS0379")]
    public void SystemIndexSourceIndexer_FromUnrelatedClass_IsInaccessible(
        string accessibility,
        string statement,
        string expectedId)
    {
        var source = $$"""
            import System

            open class Source {
                {{accessibility}} prop this[index Index] int32 {
                    get -> 0
                    set { }
                }
            }
            class Other {
                func Use(source Source) {
                    {{statement}}
                }
            }
            """;

        AssertSingleError(source, expectedId, "source");
    }

    [Fact]
    public void CompoundSourceIndexer_FromUnrelatedClass_ReportsOnce()
    {
        const string source = """
            open class Source {
                private prop this[i int32] int32 {
                    get -> i
                    set { }
                }
            }
            class Other {
                func Use(source Source) {
                    source[0] += 1
                }
            }
            """;

        AssertSingleError(source, "GS0472", "+=");
    }

    [Fact]
    public void DeclaringAndDerivedContexts_CanUseAccessibleSettersAndIndexers()
    {
        const string source = """
            open class Source {
                prop PrivateSet int32 { get; private set; }
                prop ProtectedSet int32 { get; protected set; }
                private prop this[i int32] int32 {
                    get -> i
                    set { }
                }

                func OwnAccess() int32 {
                    this[0] = 1
                    let copy = Source{ PrivateSet: this[0] }
                    return copy.PrivateSet
                }
            }
            open class Derived : Source {
                protected prop this[name string] int32 {
                    get -> name.Length
                    set { }
                }

                func DerivedAccess() int32 {
                    this["x"] = 2
                    let copy = Derived{ ProtectedSet: this["xy"] }
                    return copy.ProtectedSet
                }
            }
            let source = Source()
            let derived = Derived()
            source.OwnAccess() + derived.DerivedAccess()
            """;

        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void BracedCollectionInitializer_UsesAccessibleGetter_NotRestrictedSetter()
    {
        const string source = """
            import System.Collections.Generic

            class Source {
                prop Items IList[int32] { get; private set; }
                init() {
                    Items = List[int32]()
                }
            }
            let source = Source{ Items: { 1, 2 } }
            source.Items.Count
            """;

        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void DerivedCompositeLiteral_ThroughBaseReceiver_IsGS0379Once()
    {
        const string source = """
            open class Source {
                prop P int32 { get; protected set; }
            }
            class Derived : Source {
                func Make() Source -> Source{ P: 1 }
            }
            """;

        AssertSingleError(source, "GS0379", "P");
    }

    private static void AssertSingleError(string source, string expectedId, string expectedText)
    {
        var errors = EmittedOracle.Evaluate(source).Diagnostics.Where(d => d.IsError).ToArray();
        var error = Assert.Single(errors);
        Assert.Equal(expectedId, error.Id);
        var text = Assert.IsType<SourceText>(error.Location.Text);
        Assert.Equal(expectedText, text.ToString(error.Location.Span));
    }
}
