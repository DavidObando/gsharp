// <copyright file="Issue2918InlineLambdaErasedReceiverEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Interpreter
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

class Issue2948MethodDelegateOverloads[T] {
    func Add(callback Predicate[T]) string -> "pred"

    func Add(callback Func[T, bool]) string -> "func"
}

class Issue2948ConstructorDelegateOverloads[T] {
    init(callback Predicate[T]) {
        Kind = "pred"
    }

    init(callback Func[T, bool]) {
        Kind = "func"
    }

    prop Kind string {
        get;
    }
}

/// Issue #2918: Emitted-oracle coverage for inline lambda erased receiver.
open class Issue2918InlineLambdaErasedReceiverEmittedOracleTests {
    @Fact
    func ImportedGenericReceiverInlineLambdas_BindWithoutErrors() {
        let tree = SyntaxTree.Parse(`package Issue2918Interpreter
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
}`)
        let compilation = Compilation(tree)
        let diagnostics = tree
            .Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NominalDelegateDisagreement_KeepsMethodOverloadAmbiguous(topLevel bool) {
        const declarations = `package Issue2948MethodNominalDisagreementInterpreter
import System
import GSharp.Interpreter.Tests

class Src {
    let N int32
    init(n int32) { N = n }
}`
        const statements = "let methods = Issue2948MethodDelegateOverloads[Src]()\nConsole.WriteLine(methods.Add((item) -> true))"
        let output = RunSubmission(WithExecutionScope(declarations, statements, topLevel))
        Assert.Contains("error GS0159: Cannot find function Add.", output, StringComparison.Ordinal)
        Assert.DoesNotContain("pred", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NominalDelegateDisagreement_PreservesConstructorOverloadResolution(topLevel bool) {
        const declarations = `package Issue2948ConstructorNominalDisagreementInterpreter
import System
import GSharp.Interpreter.Tests

class Src {
    let N int32
    init(n int32) { N = n }
}`
        const statements = `let constructed = Issue2948ConstructorDelegateOverloads[Src](
    (item) -> true)
Console.WriteLine(constructed.Kind)`
        Assert.Equal("func${Environment.NewLine}", Evaluate(WithExecutionScope(declarations, statements, topLevel)))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CorpusJoinLetConstruct_Evaluates(topLevel bool) {
        const declarations = `package Issue2948CorpusJoinLetInterpreter
import System
import System.Linq

data class Owner(Id int32, Name string) {
}

data class Pet(Name string, OwnerId int32) {
}`
        const statements = `let owners []Owner = []Owner{Owner(1, "ada"), Owner(2, "bea")}
let pets []Pet = []Pet{Pet("rex", 2), Pet("tom", 1)}
let matched = owners.Join(
    pets,
    (o Owner) -> o.Id,
    (p Pet) -> p.OwnerId,
    (o Owner, p Pet) -> { return o.Name + "+" + p.Name })
Console.WriteLine(matched.Count())`
        Assert.Equal("2${Environment.NewLine}", Evaluate(WithExecutionScope(declarations, statements, topLevel)))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CorpusJoinResultSelectorLetConstruct_Evaluates(topLevel bool) {
        const declarations = `package Issue2948CorpusJoinResultInterpreter
import System
import System.Linq

data class Owner(Id int32, Name string) {
}

data class Pet(Name string, OwnerId int32) {
}`
        const statements = `let owners []Owner = []Owner{Owner(1, "ada"), Owner(2, "bea")}
let pets []Pet = []Pet{Pet("rex", 2), Pet("tom", 1)}
let matched = owners.Join(
    pets,
    (o Owner) -> o.Id,
    (p Pet) -> p.OwnerId,
    (o Owner, p Pet) -> o.Name + "+" + p.Name)
Console.WriteLine(String.Join(",", matched!!))`
        Assert.Equal(
            "ada+tom,bea+rex${Environment.NewLine}",
            Evaluate(WithExecutionScope(declarations, statements, topLevel))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CorpusJoinChainedSelectAndWriteLine_Evaluates(topLevel bool) {
        const declarations = `package Issue2948CorpusJoinChainInterpreter
import System
import System.Linq

data class Owner(Id int32, Name string) {
}

data class Pet(Name string, OwnerId int32) {
}`
        const statements = `let owners []Owner = []Owner{Owner(1, "ada"), Owner(2, "bea"), Owner(3, "cid")}
let pets []Pet = []Pet{Pet("rex", 2), Pet("tom", 1), Pet("ziggy", 2)}
let matched = owners.Join(pets, (o Owner) -> o.Id, (p Pet) -> p.OwnerId, (o Owner, p Pet) -> {
    return o.Name + "+" + p.Name
}).Select((name string) -> name)
Console.WriteLine("JoinClause: matched=${String.Join(",", matched!!)}")`
        Assert.Equal(
            "JoinClause: matched=ada+tom,bea+rex,bea+ziggy${Environment.NewLine}",
            Evaluate(WithExecutionScope(declarations, statements, topLevel))
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CanonicalLinqSelectorsOverErasedUserTypes_Evaluate(topLevel bool) {
        const declarations = `package Issue2948CanonicalLinqSelectorsInterpreter
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
        (entry IEntry) -> entry.Size)`
        const statements = `let entries = List[IEntry]{
    Entry(11),
    Entry(22),
    Entry(33)
}
Console.WriteLine(Total(entries))`
        Assert.Equal("74${Environment.NewLine}", Evaluate(WithExecutionScope(declarations, statements, topLevel)))
    }

    shared {
        private func WithExecutionScope(declarations string, statements string, topLevel bool) string -> if topLevel {
            declarations + "\n" + statements
        } else {
            declarations + `
func Run() {
` + statements + `
}
Run()`
        }

        private func Evaluate(source string) string {
            let result = EmittedOracle.Evaluate(source)
            let errors = result
                .Diagnostics
                .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
                .ToList()
            Assert.True(
                errors.Count == 0,
                "evaluation failed:\n" + string.Join(
                    "\n",
                    errors.Select((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.ToString())
                )
            )
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }

        private func RunSubmission(source string) string {
            using let output = StringWriter()
            let previousOut = Console.Out
            Console.SetOut(output)
            try {
                GSharpRepl().EvaluateSubmission(source)
            } finally {
                Console.SetOut(previousOut)
            }
            return output.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
