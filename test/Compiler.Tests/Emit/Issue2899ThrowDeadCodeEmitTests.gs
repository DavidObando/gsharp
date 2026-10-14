// <copyright file="Issue2899ThrowDeadCodeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis

/// Issue #2899: throw followed by dead code must emit valid IL when
/// definite-return accepts the enclosing non-void function.
open class Issue2899ThrowDeadCodeEmitTests {
    @Fact
    func ThrowFollowedByDeadCode_VerifiesLoadsAndRuns() {
        const Source = `package Issue2899.Emit
import System

func Value() int32 {
    throw Exception("value")
    var dead = 1
}

func Assign(out value int32) {
    throw Exception("assign")
    value = 1
}

func Conditional(condition bool) int32 {
    if condition {
        return 1
    }
    throw Exception("conditional")
    var dead = 2
}

public var result = 0
try {
    Value()
} catch (ex Exception) {
    result += 1
}

try {
    var value = 0
    Assign(out value)
} catch (ex Exception) {
    result += 2
}

result += Conditional(true)
try {
    Conditional(false)
} catch (ex Exception) {
    result += 4
}`
        let assembly = CompileAndRun(Source)
        Assert.Equal(8, GetField(assembly, "result"))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            let assemblyPath = Path.Combine(Directory.GetCurrentDirectory(), "Issue2899_${Guid.NewGuid():N}.dll")
            try {
                File.WriteAllBytes(assemblyPath, peStream.ToArray())
                IlVerifier.Verify(assemblyPath)
            } finally {
                File.Delete(assemblyPath)
            }
            let assembly = EmittedFixture.Load(peStream.ToArray())
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return assembly
        }

        private func GetField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            return int32(program.GetField(name, BindingFlags.Public | BindingFlags.Static)!!.GetValue(nil)!!)
        }
    }
}
