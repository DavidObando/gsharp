// <copyright file="Issue693DictionaryConstructionBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #693 (follow-up to #690): direct binder regression coverage for
/// <c>Dictionary[K, V]()</c> construction calls — the case PR #690 worked
/// around via <c>KeyValuePair[K, V](k, v)</c> because of a (since-resolved)
/// belief that the parser would treat <c>Dictionary[K, V]</c> as a map
/// literal. The companion <c>Issue693MultiTypeArgGenericCallParserTests</c>
/// proves the parser commits cleanly to a generic call site; these tests
/// prove the binder accepts the resulting shape with both primitive and
/// G# user-defined type arguments.
/// </summary>
public class Issue693DictionaryConstructionBindingTests
{
    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }

    [Fact]
    public void DictionaryStringInt32_DefaultConstructor_Binds()
    {
        var source = """
            import System.Collections.Generic

            var d = Dictionary[string, int32]()
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DictionaryStringInt32_AsExpressionStatement_Binds()
    {
        var source = """
            import System.Collections.Generic

            Dictionary[string, int32]()
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DictionaryStringUserClass_DefaultConstructor_Binds()
    {
        // Direct binder coverage for the case that PR #690 worked around
        // with KeyValuePair[string, MyGs].
        var source = """
            package App
            import System.Collections.Generic

            type MyGs class {
                var Name string = ""
            }

            let d = Dictionary[string, MyGs]()
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DictionaryUserClassToUserClass_DefaultConstructor_Binds()
    {
        // Both type arguments are user-defined G# classes — the most
        // demanding case for the symbolic-container path added in #690.
        var source = """
            package App
            import System.Collections.Generic

            type K class {
                var N int32 = 0
            }

            type V class {
                var N int32 = 0
            }

            let d = Dictionary[K, V]()
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void SortedDictionaryStringInt32_DefaultConstructor_Binds()
    {
        var source = """
            import System.Collections.Generic

            var d = SortedDictionary[string, int32]()
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ConcurrentDictionaryStringInt32_DefaultConstructor_Binds()
    {
        var source = """
            import System.Collections.Concurrent

            var d = ConcurrentDictionary[string, int32]()
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DictionaryWithNestedListValue_DefaultConstructor_Binds()
    {
        // Dictionary[string, List[int32]]() — nested generic in the value
        // position exercises the recursive type-clause scan inside the
        // multi-type-arg disambiguation.
        var source = """
            import System.Collections.Generic

            var d = Dictionary[string, List[int32]]()
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DictionaryWithNestedDictionaryValue_DefaultConstructor_Binds()
    {
        // Dictionary[string, Dictionary[string, int32]]() — two-type-arg
        // generic nested inside a two-type-arg generic.
        var source = """
            import System.Collections.Generic

            var d = Dictionary[string, Dictionary[string, int32]]()
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void QualifiedDictionaryStringInt32_DefaultConstructor_Binds()
    {
        var source = """
            var d = System.Collections.Generic.Dictionary[string, int32]()
            """;

        Assert.Empty(Bind(source));
    }
}
