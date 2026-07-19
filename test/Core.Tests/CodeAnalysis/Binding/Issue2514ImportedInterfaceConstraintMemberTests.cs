// <copyright file="Issue2514ImportedInterfaceConstraintMemberTests.cs" company="GSharp">
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

/// <summary>Binder coverage for imported interface constraint member lookup.</summary>
public sealed class Issue2514ImportedInterfaceConstraintMemberTests
{
    [Fact]
    public void InheritedPropertyMethodAndIndexer_BindWithGenericSubstitution()
    {
        const string source = """
            import System.Collections.Generic

            func ReadCount[T IList[string]](value T) int32 -> value.Count
            func Read[T IList[string]](value T, index int32) string -> value[index]
            func Write[T IList[string]](value T, index int32, text string) {
                value[index] = text
            }
            func Find[T IList[string]](value T, text string) int32 -> value.IndexOf(text)
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ConstructorFlag_CombinesWithImportedInterfaceConstraint()
    {
        const string source = """
            import System

            func Compare[T IComparable[T] init()](value T) int32 -> value.CompareTo(value)
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void SourceInterfaceConstraint_ControlRemainsGreen()
    {
        const string source = """
            interface ISource {
                prop Name string { get; set; }
            }

            func Use[T ISource](value T) string {
                value.Name = "ok"
                return value.Name
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void UnknownImportedConstraintMember_StillReportsGS0158()
    {
        const string source = """
            import System.Collections.Generic

            func Bad[T IList[string]](value T) int32 -> value.Missing
            """;

        Assert.Contains(Bind(source), diagnostic => diagnostic.Id == "GS0158");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>())
            .Diagnostics
            .ToList();
    }
}
