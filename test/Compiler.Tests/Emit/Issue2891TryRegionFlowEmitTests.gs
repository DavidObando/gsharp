// <copyright file="Issue2891TryRegionFlowEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Threading.Tasks
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import Xunit.Sdk

/// Issue #2891: accepted try-region control-flow shapes must emit verifiable
/// assemblies, load successfully, and execute their finally behavior.
open class Issue2891TryRegionFlowEmitTests {
    @Theory
    @MemberData("FiniteCases")
    func AcceptedFiniteShape_VerifiesLoadsAndRuns(name string, expected int32, source string) {
        let assembly = CompileVerifyLoadAndRun(name, source)
        Assert.Equal(expected, GetField(assembly, "result"))
    }

    @Theory
    @MemberData("BranchAnalysisExecutionCases")
    func NestedBranchAnalysis_LoadsAndRunsInChild(
        name string,
        expectedOutput string,
        source string
    ) -> CompileLoadAndRunChild(name, source, expectedOutput)

    @Theory
    @InlineData("FinallyInfiniteLoop", false)
    @InlineData("BreakSuppressedByInfiniteFinally", true)
    func InfiniteFinally_VerifiesLoadsStartsAndIsBounded(name string, startsWithBreak bool) {
        let body = if startsWithBreak {
            `for {
    try {
        break
    } finally {
        Console.WriteLine("entered")
        for {
        }
    }
}`
        } else {
            `try {
    var value = 1
} finally {
    Console.WriteLine("entered")
    for {
    }
}`
        }
        let source = (`package Issue2891.Emit` + "$name" + `
import System
func F() int32 {
` + "$body" + `
}
F()`)
        CompileLoadAndRunChild(name, source)
    }

    shared {
        /// Gets finite accepted try-region programs and their expected result.
        func FiniteCases() sequence[[]object] {
            yield Case("TryContinue", 3, `func F() int32 {
    var count = 0
    for i in 0 ... 3 {
        try {
            continue
        } finally {
            count += 1
        }
    }
    return count
}
public var result = F()`)
            yield Case("LabeledTryContinue", 2, `func F() int32 {
    var count = 0
    outer: for i in 0 ... 2 {
        for j in 0 ... 2 {
            try {
                continue outer
            } finally {
                count += 1
            }
        }
    }
    return count
}
public var result = F()`)
            yield Case("CatchContinue", 3, `import System
func F() int32 {
    var count = 0
    for i in 0 ... 3 {
        try {
            throw Exception("boom")
        } catch (ex Exception) {
            count += 1
            continue
        }
    }
    return count
}
public var result = F()`)
            yield Case("FinallyContinue", 3, `func F() int32 {
    var count = 0
    for i in 0 ... 3 {
        try {
        } finally {
            count += 1
            continue
        }
    }
    return count
}
public var result = F()`)
            yield Case("LabeledCatchContinue", 2, `import System
func F() int32 {
    var count = 0
    outer: for i in 0 ... 2 {
        for j in 0 ... 2 {
            try {
                throw Exception("boom")
            } catch (ex Exception) {
                count += 1
                continue outer
            }
        }
    }
    return count
}
public var result = F()`)
            yield Case("LabeledFinallyContinue", 2, `func F() int32 {
    var count = 0
    outer: for i in 0 ... 2 {
        for j in 0 ... 2 {
            try {
            } finally {
                count += 1
                continue outer
            }
        }
    }
    return count
}
public var result = F()`)
            yield Case("TryFinallyReturn", 3, `public var finalCount = 0
func F() int32 {
    try {
        return 2
    } finally {
        finalCount += 1
    }
}
public var result = F() + finalCount`)
            yield Case("FinallyReturn", 2, `func F() int32 {
    try {
        return 1
    } finally {
        return 2
    }
}
public var result = F()`)
            yield Case("ConditionalFinallyReturnOverException", 9, `import System
func F(replace bool) int32 {
    try {
        throw Exception("origin")
    } finally {
        if replace {
            return 2
        }
    }
}
public var result = F(true)
try {
    F(false)
} catch (ex Exception) {
    result += ex.Message == "origin" ? 7 : -100
}`)
            yield Case("ConditionalFinallyReturnOverReturn", 3, `func F(replace bool) int32 {
    try {
        return 1
    } finally {
        if replace {
            return 2
        }
    }
}
public var result = F(false) + F(true)`)
            yield Case("ConditionalFinallyReturnOverBreak", 2, `func F(replace bool) int32 {
    var count = 0
    for i in 0 ... 3 {
        try {
            break
        } finally {
            if replace {
                return 2
            }
        }
        count += 1
    }
    return count
}
public var result = F(false) + F(true)`)
            // `Origin` carries a loop purely so the JIT will not inline it:
            // the assertion below reads its frame out of the rethrown stack
            // trace, and an inlined frame simply is not there. Code loaded into
            // a collectible context is jitted with full optimizations from the
            // start, so a one-line thrower would vanish (issue #3828).
            yield Case("RethrowPreservesOriginStack", 7, `import System
func Origin() {
    var pad = 0
    for var i = 0; i < 3; i++ {
        pad += i
    }
    throw Exception("origin" + pad.ToString())
}
func F(replace bool) int32 {
    try {
        Origin()
        return 0
    } finally {
        if replace {
            return 2
        }
    }
}
public var result = F(true)
try {
    F(false)
} catch (ex Exception) {
    result += ex.StackTrace!!.Contains("<Program>.Origin") ? 5 : -100
}`)
            yield Case("ExceptionSuppressedByFinallyBreak", 4, `import System
func F() int32 {
    for {
        try {
            throw Exception("origin")
        } finally {
            break
        }
    }
    return 4
}
public var result = F()`)
            yield Case("ExceptionSuppressedByFinallyContinue", 3, `import System
func F() int32 {
    var count = 0
    for i in 0 ... 3 {
        try {
            throw Exception("origin")
        } finally {
            count += 1
            continue
        }
    }
    return count
}
public var result = F()`)
            yield Case("ExceptionSuppressedByFinallyGoto", 5, `import System
func F() int32 {
    try {
        throw Exception("origin")
    } finally {
        goto done
    }
done:
    return 5
}
public var result = F()`)
            yield Case("TryCatchReturns", 3, `import System
func F(flag bool) int32 {
    try {
        if flag {
            return 1
        }
        throw Exception("boom")
    } catch (ex Exception) {
        return 2
    }
}
public var result = F(true) + F(false)`)
            yield Case("TryCatchFinallyReturns", 5, `import System
public var finalCount = 0
func F(flag bool) int32 {
    try {
        if flag {
            return 1
        }
        throw Exception("boom")
    } catch (ex Exception) {
        return 2
    } finally {
        finalCount += 1
    }
}
public var result = F(true) + F(false) + finalCount`)
            yield Case("ConditionalFinallyReturnOverCatchReturn", 3, `import System
func F(replace bool) int32 {
    try {
        throw Exception("origin")
    } catch (ex Exception) {
        return 1
    } finally {
        if replace {
            return 2
        }
    }
}
public var result = F(false) + F(true)`)
            yield Case("CatchRethrows", 7, `import System
func F() int32 {
    try {
        throw Exception("first")
    } catch (ex Exception) {
        throw Exception("second")
    }
}
public var result = 0
try {
    F()
} catch (ex Exception) {
    result = ex.Message == "second" ? 7 : -1
}`)
            yield Case("FinallyThrows", 9, `import System
func F() int32 {
    try {
        var value = 1
    } finally {
        throw Exception("stop")
    }
}
public var result = 0
try {
    F()
} catch (ex Exception) {
    result = ex.Message == "stop" ? 9 : -1
}`)
            yield Case("ReturnAfterTryBreak", 7, `func F() int32 {
    for {
        try {
            break
        } finally {
        }
    }
    return 7
}
public var result = F()`)
            yield Case("ReturnAfterCatchBreak", 8, `import System
func F() int32 {
    for {
        try {
            throw Exception("boom")
        } catch (ex Exception) {
            break
        }
    }
    return 8
}
public var result = F()`)
            yield Case("TryGotoThenReturn", 3, `public var finalCount = 0
func F() int32 {
    try {
        goto done
    } finally {
        finalCount += 1
    }
    return 1
done:
    return 2
}
public var result = F() + finalCount`)
            yield Case("CatchGotoThenReturn", 2, `import System
func F() int32 {
    try {
        throw Exception("boom")
    } catch (ex Exception) {
        goto done
    }
    return 1
done:
    return 2
}
public var result = F()`)
            yield Case("FinallyGotoThenReturn", 2, `func F() int32 {
    try {
        return 1
    } finally {
        goto done
    }
done:
    return 2
}
public var result = F()`)
            yield Case("TryInsideFinallyReturns", 1, `func F() int32 {
    try {
        return 1
    } finally {
        try {
            var value = 2
        } finally {
        }
    }
}
public var result = F()`)
            yield Case("NestedFinallyBreakThenReturn", 6, `func F() int32 {
    for {
        try {
            return 1
        } finally {
            try {
                break
            } finally {
            }
        }
    }
    return 6
}
public var result = F()`)
            yield Case("SwitchInsideTryBreakOverriddenByReturn", 1, `func F() int32 {
    for {
        try {
            switch 0 {
                default { break }
            }
        } finally {
            return 1
        }
    }
}
public var result = F()`)
            yield Case("SelectInsideTryBreakOverriddenByReturn", 2, `func F() int32 {
    for {
        try {
            select {
                default { break }
            }
        } finally {
            return 2
        }
    }
}
public var result = F()`)
            yield Case("ScopeInsideTryBreakOverriddenByReturn", 4, `func F() int32 {
    for {
        try {
            scope {
                break
            }
        } finally {
            return 4
        }
    }
}
public var result = F()`)
        }

        /// Gets nested branch-analysis shapes that require runtime execution guards.
        func BranchAnalysisExecutionCases() sequence[[]object] {
            yield OutputCase("LocalGotoInTry", `fin#1
r=1301
`, `import System
func F() int32 {
    var result = 100
    for {
        try {
        again:
            result += 1
            if result < 103 {
                goto again
            }
            result += 1198
        } finally {
            Console.WriteLine("fin#1")
            break
        }
    }
    return result
}
Console.WriteLine("r=" + F().ToString())`)
            yield OutputCase("LocalGotoInNestedFinally", `outerfin
r=5
`, `import System
func F() int32 {
    var result = 0
    for {
        try {
            try {
            } finally {
                goto local
            local:
                result = 5
            }
        } finally {
            Console.WriteLine("outerfin")
            break
        }
    }
    return result
}
Console.WriteLine("r=" + F().ToString())`)
            yield OutputCase("LocalGotoInNestedCatch", `outerfin
r=3
`, `import System
func F() int32 {
    var result = 0
    for {
        try {
            try {
                throw Exception("enter catch")
            } catch (ex Exception) {
                goto local
            local:
                result = 3
            }
        } finally {
            Console.WriteLine("outerfin")
            break
        }
    }
    return result
}
Console.WriteLine("r=" + F().ToString())`)
        }

        private func Case(name string, expected int32, body string)[]object -> []object{
            name,
            expected,
            "package Issue2891.Emit$name${Environment.NewLine}$body"
        }

        private func OutputCase(name string, expectedOutput string, body string)[]object -> []object{
            name,
            expectedOutput,
            "package Issue2891.Emit$name${Environment.NewLine}$body"
        }

        private func CompileVerifyLoadAndRun(name string, source string) Assembly {
            using let peStream = MemoryStream()
            var result EmitResult
            try {
                result = Compilation(SyntaxTree.Parse(SourceText.From(source))).Emit(peStream)
            } catch (exception Exception) {
                throw XunitException(exception.ToString())
            }
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> "${diagnostic.Id}: ${diagnostic.Message}")
                )
            )
            let bytes = peStream.ToArray()
            let assemblyPath = Path.Combine(
                Directory.GetCurrentDirectory(),
                "Issue2891_${name}_${Guid.NewGuid():N}.dll"
            )
            try {
                File.WriteAllBytes(assemblyPath, bytes)
                IlVerifier.Verify(assemblyPath)
            } finally {
                File.Delete(assemblyPath)
            }
            let assembly = EmittedFixture.Load(bytes)
            let types = assembly.GetTypes()
            Assert.NotEmpty(types)
            let program = types.Single((type Type) -> type.Name == "<Program>")
            let entry = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )!!
            let execution = Task.Run(
                () -> entry.Invoke(
                    nil,
                    if entry.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            )
            Assert.True(execution.Wait(TimeSpan.FromSeconds(10)), "$name execution timed out")
            return assembly
        }

        private func CompileLoadAndRunChild(name string, source string, expectedOutput string? = nil) {
            let prefix = "Issue2891_${name}_${Guid.NewGuid():N}"
            let directory = Directory.GetCurrentDirectory()
            let sourcePath = Path.Combine(directory, prefix + ".gs")
            let assemblyPath = Path.Combine(directory, prefix + ".dll")
            try {
                File.WriteAllText(sourcePath, source)
                let exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.Equal(0, exitCode)
                IlVerifier.Verify(assemblyPath)
                Assert.NotEmpty(EmittedFixture.Load(assemblyPath).GetTypes())
                let start = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                start.ArgumentList.Add("exec")
                start.ArgumentList.Add("--runtimeconfig")
                start.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
                start.ArgumentList.Add(assemblyPath)
                using let process = Process.Start(start)!!
                let stdoutTask = process.StandardOutput.ReadToEndAsync()
                let stderrTask = process.StandardError.ReadToEndAsync()
                let exited = process.WaitForExit(
                    if expectedOutput == nil {
                        3_000
                    } else {
                        10_000
                    }
                )
                if !exited {
                    process.Kill(entireProcessTree: true)
                    Assert.True(process.WaitForExit(5_000), "$name child did not stop after kill")
                }
                let stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine)
                let stderr = stderrTask.GetAwaiter().GetResult()
                if expectedOutput == nil {
                    Assert.False(exited, ("$name" + ` unexpectedly completed
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                    Assert.Contains("entered", stdout, StringComparison.Ordinal)
                } else {
                    Assert.True(exited, "$name execution timed out")
                    Assert.Equal(0, process.ExitCode)
                    Assert.Equal(string.Empty, stderr)
                    Assert.Equal(expectedOutput, stdout)
                }
            } finally {
                for path in Directory.EnumerateFiles(directory, prefix + "*") {
                    File.Delete(path)
                }
            }
        }

        private func GetField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            return int32(program.GetField(name, BindingFlags.Public | BindingFlags.Static)!!.GetValue(nil)!!)
        }
    }
}
