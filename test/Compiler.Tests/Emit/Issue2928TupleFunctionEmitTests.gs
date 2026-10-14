// <copyright file="Issue2928TupleFunctionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2928: tuple-contained function values execute correctly through the
/// compiled backend, pinned to an explicit output value.
open class Issue2928TupleFunctionEmitTests {
    @Fact
    func TupleFunction_CompiledBackendExecutes() {
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(Source))
    }

    @Fact
    func CompileAndRunHarness_PropagatesKnownBadProgram() {
        const KnownBadSource = `package TupleFunctionKnownBad
import System

throw InvalidOperationException("known bad")`
        let exception = Assert.Throws[TargetInvocationException](
            func () object? {
                return CompileAndRun(KnownBadSource)
            }
        )
        Assert.IsType[InvalidOperationException](exception.InnerException)
    }

    shared {
        private const Source string = `package TupleFunctionEmit
import System

let handler (int32) -> int32 = (value int32) -> value + 1
let t = (handler, 0)
Console.WriteLine(t.Item1(41))`

        private func CompileAndRun(source string) string {
            using let peStream = MemoryStream()
            let result = Compilation(SyntaxTree.Parse(source)).Emit(peStream)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            let assembly = EmittedFixture.Load(peStream.ToArray())
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            using let writer = StringWriter()
            let previous = Console.Out
            Console.SetOut(writer)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(previous)
            }
            return writer.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
