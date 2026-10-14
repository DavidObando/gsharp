// <copyright file="Issue2224AnonymousClassEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2224: end-to-end emission of the `object { let ... }`
/// anonymous-class-literal expression. The synthesized backing type reuses
/// the existing `data class` emission pipeline (ADR-0029) verbatim —
/// this test exercises that a real CLR TypeDef is produced, member access
/// works, and the synthesized `Equals`/`GetHashCode`/`ToString`
/// match C# anonymous-type semantics closely enough for LINQ/EF-style
/// projection use.
open class Issue2224AnonymousClassEmitTests {
    @Fact
    func AnonymousClass_MemberAccess_EmitsAndRuns() {
        const source = `package Corpus.Issue2224

import System

var x = object {
    let Name = "Foo"
    let Age int32 = 42
}
Console.WriteLine(x.Name)
Console.WriteLine(x.Age.ToString())`
        let output = CompileAndRun("Issue2224MemberAccess", ReferenceResolver.Default(), source)
        Assert.Equal("Foo" + Environment.NewLine + "42" + Environment.NewLine, output)
    }

    // Coverage for the actual reported GS0473-inside-expression-tree scenario
    // lives in AnonymousClassExpressionTests.AnonymousClass_InsideExpressionTreeLambda_DoesNotReportGS0473
    // (binding-level diagnostics test, matching the existing
    // Issue2130ExpressionTreeBindingTests style).
    @Fact
    func AnonymousClass_StructuralEquality_MatchesCSharpAnonymousTypeSemantics() {
        // ADR-0146 / issue #2243: value equality is a `data object` feature.
        const source = `package Corpus.Issue2224

import System

var a = data object { let Id int32 = 1; let Alias = "x" }
var b = data object { let Id int32 = 1; let Alias = "x" }
var c = data object { let Id int32 = 2; let Alias = "x" }
Console.WriteLine((a == b).ToString())
Console.WriteLine((a == c).ToString())
Console.WriteLine(a.GetHashCode() == b.GetHashCode())`
        let output = CompileAndRun("Issue2224StructuralEquality", ReferenceResolver.Default(), source)
        let lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("True", lines[0])
        Assert.Equal("False", lines[1])
        Assert.Equal("True", lines[2])
    }

    shared {
        /// Compiles and emits [`source`](paramref), loads the resulting PE,
        /// invokes its entry point, and returns captured console output.
        private func CompileAndRun(contextName string, references ReferenceResolver, source string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(references, tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } catch (ex TargetInvocationException) when ex.InnerException is AggregateException agg {
                    throw agg.InnerException ?? agg
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
