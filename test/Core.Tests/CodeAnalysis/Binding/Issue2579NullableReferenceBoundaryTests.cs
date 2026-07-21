// <copyright file="Issue2579NullableReferenceBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2579NullableReferenceBoundaryTests
{
    [Fact]
    public void GuardsAndAssertions_EnableReferenceUsesAcrossAllBoundaries()
    {
        EvaluationResult result = Evaluate("""
            import System
            import System.Collections.Generic

            func Length(value string) int32 -> value.Length

            var value string? = "key"
            var list = List[string]()
            list.Add("a")
            list.Add("b")
            var values IEnumerable[string]? = list
            var dict = Dictionary[string, int32]()
            var total = 0

            if value != nil {
                var assigned string = value
                total += Length(value)
                dict[value] = assigned.Length
            }

            if !String.IsNullOrEmpty(value) {
                total += Length(value)
            }

            if values != nil {
                for item in values {
                    total += item.Length
                }
            }

            total += Length(value!!)
            total
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void UnguardedNullableReferencesRemainHardErrors()
    {
        EvaluationResult result = Evaluate("""
            import System.Collections.Generic

            func Consume(value string) {}

            var value string? = nil
            var values IEnumerable[string]? = nil
            var dict = Dictionary[string, int32]()
            var assigned string = value
            Consume(value)
            var length = value.Length
            var indexed = dict[value]
            for item in values {}
            """);

        Assert.True(result.Diagnostics.Count() >= 5);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0158");
        Assert.Contains(result.Diagnostics, diagnostic =>
            diagnostic.Id is "GS0154" or "GS0155" or "GS0156");
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0116");
    }

    [Fact]
    public void NullableValuesAndInvalidReferenceConversionsRemainHardErrors()
    {
        EvaluationResult result = Evaluate("""
            interface IService {}
            class Service : IService {}
            class Other {}

            func NeedInt(value int32) {}
            func NeedService(value IService) {}

            var number int32? = 1
            var service Service? = nil
            var other = Other()
            NeedInt(number)
            NeedService(service)
            NeedService(other)
            """);

        Assert.True(result.Diagnostics.Count() >= 3);
        Assert.All(result.Diagnostics, diagnostic =>
            Assert.Contains(diagnostic.Id, new[] { "GS0154", "GS0155", "GS0156" }));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
