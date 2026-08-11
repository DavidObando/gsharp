// <copyright file="Issue2918InlineLambdaErasedReceiverEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

public sealed class Issue2948MethodDelegateOverloads<T>
{
    public string Add(Predicate<T> callback) => "pred";

    public string Add(Func<T, bool> callback) => "func";
}

public sealed class Issue2948ConstructorDelegateOverloads<T>
{
    public Issue2948ConstructorDelegateOverloads(Predicate<T> callback) =>
        Kind = "pred";

    public Issue2948ConstructorDelegateOverloads(Func<T, bool> callback) =>
        Kind = "func";

    public string Kind { get; }
}

/// <summary>
/// Issue #2918: Emitted-oracle coverage for inline lambda erased receiver.
/// </summary>
public class Issue2918InlineLambdaErasedReceiverEmittedOracleTests
{
    [Fact]
    public void ImportedGenericReceiverInlineLambdas_BindWithoutErrors()
    {
        var tree = SyntaxTree.Parse("""
            package Issue2918Interpreter
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let callbacks = List[Action[Src]]()
                callbacks.Add((item Src) -> Console.WriteLine(item.N))

                let nested = List[Action[List[Src]]]()
                nested.Add((items List[Src]) -> Console.WriteLine(items[0].N))
            }
            """);
        var compilation = new Compilation(tree);
        var diagnostics = tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NominalDelegateDisagreement_KeepsMethodOverloadAmbiguous(bool topLevel)
    {
        const string declarations = """
            package Issue2948MethodNominalDisagreementInterpreter
            import System
            import GSharp.Interpreter.Tests

            class Src {
                let N int32
                init(n int32) { N = n }
            }
            """;

        const string statements = """
            let methods = Issue2948MethodDelegateOverloads[Src]()
            Console.WriteLine(methods.Add((item) -> true))
            """;

        var output = RunSubmission(
            WithExecutionScope(declarations, statements, topLevel));
        Assert.Contains("error GS0159: Cannot find function Add.", output, StringComparison.Ordinal);
        Assert.DoesNotContain("pred", output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NominalDelegateDisagreement_PreservesConstructorOverloadResolution(bool topLevel)
    {
        const string declarations = """
            package Issue2948ConstructorNominalDisagreementInterpreter
            import System
            import GSharp.Interpreter.Tests

            class Src {
                let N int32
                init(n int32) { N = n }
            }
            """;

        const string statements = """
            let constructed = Issue2948ConstructorDelegateOverloads[Src](
                (item) -> true)
            Console.WriteLine(constructed.Kind)
            """;

        Assert.Equal(
            $"func{Environment.NewLine}",
            Evaluate(WithExecutionScope(declarations, statements, topLevel)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CorpusJoinLetConstruct_Evaluates(bool topLevel)
    {
        const string declarations = """
            package Issue2948CorpusJoinLetInterpreter
            import System
            import System.Linq

            data class Owner(Id int32, Name string) {
            }

            data class Pet(Name string, OwnerId int32) {
            }
            """;

        const string statements = """
            let owners []Owner = []Owner{Owner(1, "ada"), Owner(2, "bea")}
            let pets []Pet = []Pet{Pet("rex", 2), Pet("tom", 1)}
            let matched = owners.Join(
                pets,
                (o Owner) -> o.Id,
                (p Pet) -> p.OwnerId,
                (o Owner, p Pet) -> { return o.Name + "+" + p.Name })
            Console.WriteLine(matched.Count())
            """;

        Assert.Equal(
            $"2{Environment.NewLine}",
            Evaluate(WithExecutionScope(declarations, statements, topLevel)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CorpusJoinResultSelectorLetConstruct_Evaluates(bool topLevel)
    {
        const string declarations = """
            package Issue2948CorpusJoinResultInterpreter
            import System
            import System.Linq

            data class Owner(Id int32, Name string) {
            }

            data class Pet(Name string, OwnerId int32) {
            }
            """;

        const string statements = """
            let owners []Owner = []Owner{Owner(1, "ada"), Owner(2, "bea")}
            let pets []Pet = []Pet{Pet("rex", 2), Pet("tom", 1)}
            let matched = owners.Join(
                pets,
                (o Owner) -> o.Id,
                (p Pet) -> p.OwnerId,
                (o Owner, p Pet) -> o.Name + "+" + p.Name)
            Console.WriteLine(String.Join(",", matched!!))
            """;

        Assert.Equal(
            $"ada+tom,bea+rex{Environment.NewLine}",
            Evaluate(WithExecutionScope(declarations, statements, topLevel)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CorpusJoinChainedSelectAndWriteLine_Evaluates(bool topLevel)
    {
        const string declarations = """
            package Issue2948CorpusJoinChainInterpreter
            import System
            import System.Linq

            data class Owner(Id int32, Name string) {
            }

            data class Pet(Name string, OwnerId int32) {
            }
            """;

        const string statements = """
            let owners []Owner = []Owner{Owner(1, "ada"), Owner(2, "bea"), Owner(3, "cid")}
            let pets []Pet = []Pet{Pet("rex", 2), Pet("tom", 1), Pet("ziggy", 2)}
            let matched = owners.Join(pets, (o Owner) -> o.Id, (p Pet) -> p.OwnerId, (o Owner, p Pet) -> {
                return o.Name + "+" + p.Name
            }).Select((name string) -> name)
            Console.WriteLine("JoinClause: matched=${String.Join(",", matched!!)}")
            """;

        Assert.Equal(
            $"JoinClause: matched=ada+tom,bea+rex,bea+ziggy{Environment.NewLine}",
            Evaluate(WithExecutionScope(declarations, statements, topLevel)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CanonicalLinqSelectorsOverErasedUserTypes_Evaluate(bool topLevel)
    {
        const string declarations = """
            package Issue2948CanonicalLinqSelectorsInterpreter
            import System
            import System.Collections.Generic
            import System.Linq

            interface IEntry {
                prop Size int64 {
                    get;
                }
            }

            class Entry : IEntry {
                prop Size int64 {
                    get;
                    init;
                }

                init(size int64) { Size = size }
            }

            func Total(entries List[IEntry]) int64 ->
                int64(8) + entries.Sum(
                    (entry IEntry) -> entry.Size)
            """;

        const string statements = """
            let entries = List[IEntry]{
                Entry(11),
                Entry(22),
                Entry(33)
            }
            Console.WriteLine(Total(entries))
            """;

        Assert.Equal(
            $"74{Environment.NewLine}",
            Evaluate(WithExecutionScope(declarations, statements, topLevel)));
    }

    private static string WithExecutionScope(
        string declarations,
        string statements,
        bool topLevel) =>
        topLevel
            ? declarations + "\n" + statements
            : declarations + "\nfunc Run() {\n" + statements + "\n}\nRun()";

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        var errors = result.Diagnostics.Where(diagnostic => diagnostic.IsError).ToList();
        Assert.True(
            errors.Count == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(diagnostic => diagnostic.ToString())));
        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }

    private static string RunSubmission(string source)
    {
        using var output = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(output);
        try
        {
            new GSharpRepl().EvaluateSubmission(source);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return output.ToString().ReplaceLineEndings(Environment.NewLine);
    }
}
