// <copyright file="Issue2621ImportedGenericConstructorTests.cs" company="GSharp">
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

public sealed class Issue2621ImportedGenericConstructorTests
{
    [Fact]
    public void OahuCli_ListOfNestedGeneric_WithCapacity_Binds()
    {
        const string source = """
            package Oahu.Cli.Commands
            import System.Collections.Generic

            func BuildRows(capacity int32) List[IReadOnlyDictionary[string, object?]] {
                return List[IReadOnlyDictionary[string, object?]](capacity)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedGenericConstructor_MismatchedOverload_IsNotMissingFunction()
    {
        const string source = """
            package Oahu.Cli.Commands
            import System.Collections.Generic

            func BuildRows() {
                let rows = List[IReadOnlyDictionary[string, object?]]("bad")
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0267");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS0130");
    }

    [Fact]
    public void ImportedGenericConstructor_ArgumentError_DoesNotCascadeToMissingFunction()
    {
        const string source = """
            package Oahu.Cli.Commands
            import System.Collections.Generic

            func BuildRows() {
                let rows = List[IReadOnlyDictionary[string, object?]](missing.Count)
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0157");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id is "GS0130" or "GS0267");
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;
    }
}
