// <copyright file="CatchElidedVariableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Regression tests for issue #420 (P3-6): `ReflectionMetadataEmitter.EmitCatchClauses`
/// previously assumed `BoundCatchClause.Variable` was non-null and had a
/// local slot allocated. If a future binder pass elides an unused catch
/// variable, the emitter would NRE and/or leave the exception object on the
/// evaluation stack producing unverifiable IL. These tests verify both the
/// normal positive path and the defensive `pop` path.
open class CatchElidedVariableEmitTests {
    @Fact
    func Normal_Catch_With_Variable_Still_Works() {
        const Source = `package CatchNormal
import System

func run() int32 {
    var result = 0
    try {
        var n = Int32.Parse("bad")
        result = n
    } catch (e Exception) {
        result = 42
    }
    return result
}

Console.WriteLine(run())
`
        let output = CompileAndRun(Source, "CatchNormal")
        Assert.Contains("42", output)
    }

    @Fact
    func Catch_With_Elided_Variable_Emits_Pop_And_Runs() {
        // Simulate a future binder pass that elides the catch variable: bind the
        // program normally then mutate every BoundCatchClause to drop its
        // Variable before emitting. Without the defensive Pop in EmitCatchClauses
        // this would either NRE during emit (Variable == null) or produce
        // unverifiable IL (exception object left on the evaluation stack on
        // handler entry).
        const Source = `package CatchElided
import System

func run() int32 {
    var result = 0
    try {
        var n = Int32.Parse("bad")
        result = n
    } catch (e Exception) {
        result = 42
    }
    return result
}

Console.WriteLine(run())
`
        let output = CompileAndRunMutated(Source, "CatchElided")
        Assert.Contains("42", output)
    }

    private class CatchClauseElider : BoundTreeWalker {
        prop MutatedCount int32 {
            get;
            private set;
        }

        protected override func VisitTryStatement(node BoundTryStatement) {
            for clause in node.CatchClauses {
                Assert.NotNull(VariableBackingField)
                if VariableBackingField.GetValue(clause) != nil {
                    VariableBackingField.SetValue(clause, nil)
                    this.MutatedCount++
                }
            }
            base.VisitTryStatement(node)
        }

        shared {
            private let VariableBackingField FieldInfo = typeof(BoundCatchClause).GetField(
                "<Variable>k__BackingField",
                BindingFlags.Instance | BindingFlags.NonPublic
            )!!
        }
    }

    shared {
        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            return LoadAndExecute(peStream, contextName)
        }

        private func CompileAndRunMutated(source string, contextName string) string {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let syntaxDiagnostics = compilation.GlobalScope.Diagnostics
            Assert.False(
                syntaxDiagnostics.Any((d Diagnostic) -> d.IsError),
                "no syntax errors: " + string.Join("; ", syntaxDiagnostics.Select((d Diagnostic) -> d.Message))
            )
            let program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope)
            Assert.False(
                program.Diagnostics.Any((d Diagnostic) -> d.IsError),
                "no binding errors: " + string.Join("; ", program.Diagnostics.Select((d Diagnostic) -> d.Message))
            )
            var mutated = 0
            for body in program.Functions.Values {
                let walker = CatchClauseElider()
                walker.Visit(body)
                mutated += walker.MutatedCount
            }
            Assert.True(mutated > 0, "expected to find at least one catch clause to mutate")
            using let peStream = MemoryStream()
            ReflectionMetadataEmitter.Emit(program, peStream)
            return LoadAndExecute(peStream, contextName)
        }

        private func LoadAndExecute(peStream MemoryStream, contextName string) string {
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
                } catch (tie TargetInvocationException) {
                    Console.SetOut(stdout)
                    throw Exception(
                        "Entry point threw: ${tie.InnerException?.GetType().Name}: ${tie.InnerException?.Message}",
                        tie.InnerException
                    )
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
