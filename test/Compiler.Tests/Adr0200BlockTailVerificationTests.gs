// <copyright file="Adr0200BlockTailVerificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// ADR-0200 / issues #4963, #4965, #4966: every shape that gives a value block
/// the `never` type, or makes an if/switch the void construct, must emit
/// verifiable IL — the never-produced value sits after an exiting statement,
/// a void or never switch has no result slot, and lowering must not
/// materialize a `never` temporary.
open class Adr0200BlockTailVerificationTests {
    @Theory
    @MemberData("Cases")
    func EmittedAssembly_PassesIlVerification(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_0200_ilv_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, name + ".dll")
            let args = List[string]{"/out:" + outPath, "/target:library", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, "gsc failed for '$name':\n$compileOut\n$compileErr")
            IlVerifier.Verify(outPath)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        func Cases() sequence[[]object] {
            yield[]object{"return-branch-in-binary-operand", `
package P
func F(c bool) int32 {
    let x = 1 + if c { 2 } else { return 0 }
    return x
}`}
            yield[]object{"both-branches-exit", `
package P
func F(c bool) int32 {
    let f = (b bool) -> { if b { return 1 } else { return 2 } }
    return f(c)
}`}
            yield[]object{"throw-tail-under-defer-and-using", `
package P
import System
import System.IO
func F(c bool) int32 {
    let v int32 = if c { 1 } else {
        using let m = MemoryStream()
        defer Console.WriteLine("d")
        throw InvalidOperationException("x")
    }
    return v
}`}
            yield[]object{"continue-and-break-tails", `
package P
func F() int32 {
    var total = 0
    for var i = 0; i < 10; i++ {
        let v = if i == 1 { continue } else if i == 5 { break } else { i }
        total = total + v
    }
    return total
}`}
            yield[]object{"never-switch-statement-tail", `
package P
func F(k int32) int32 {
    let v int32 = {
        switch k {
        case 1 { return 11 }
        default { return 22 }
        }
    }
    return v
}`}
            yield[]object{"never-arms-in-statement-switch-expression", `
package P
func F(k int32) string {
    switch k {
    case 1: { return "one" }
    default: { return "other" }
    }
}`}
            yield[]object{"never-arm-in-async-body", `
package P
import System.Threading.Tasks
async func F(c bool) Task[int32] {
    let a = if c {
        await Task.Delay(1)
        1
    } else { return 0 }
    return a + 1
}`}
            yield[]object{"void-switch-with-await-and-no-default", `
package P
import System
import System.Threading.Tasks
async func F(x int32) -> switch x {
case 1: await Task.Delay(1)
case 2: Console.WriteLine("two")
}`}
            yield[]object{"never-tail-under-cleanup-in-lambda", `
package P
import System
func F(c bool) int32 {
    let f = (b bool) -> {
        defer Console.WriteLine("d")
        if b { return 1 } else { return 2 }
    }
    for var i = 0; i < 3; i++ {
        let v int32 = if i == 1 {
            defer Console.WriteLine("skip")
            continue
        } else { i }
        Console.WriteLine(v)
    }
    return f(c)
}`}
            yield[]object{"never-only-lambda", `
package P
import System
func F() {
    let f = () -> { { throw Exception("x") } }
    f()
}`}
            yield[]object{"return-inside-return-operand", `
package P
func F(c bool) int64 {
    let f = (b bool) -> { return if b { return int64(2) } else { 1 } }
    let g = (b bool) -> { return if b { 1 } else { return int64(3) } }
    return f(c) + g(c)
}`}
            yield[]object{"exiting-call-arguments", `
package P
func Sink(a int32, b int32) int32 {
    return a + b
}
func F(c bool) int32 {
    return Sink(if c { return 1 } else { return 2 }, if c { 3 } else { return 4 })
}`}
            yield[]object{"exiting-operand-before-await", `
package P
import System
import System.Threading.Tasks
func Sink(a int32, b int32) int32 {
    return a + b
}
async func F(c bool) Task[int32] {
    return Sink(if c { return 1 } else { return 2 }, await Task.FromResult(3))
}
async func G() Task[int32] {
    return Sink(throw Exception("x"), await Task.FromResult(3))
}`}
            yield[]object{"void-if-and-void-switch", `
package P
import System
import System.Collections.Generic
func F(c bool, x int32, list List[int32]) {
    let a Action = () -> if c { Console.WriteLine("a") }
    let b Action = () -> { if c { list.Remove(1) } else { list.Clear() } }
    let s Action = () -> switch x {
    case 1: Console.WriteLine("one")
    case 2: list.Add(2)
    }
    a()
    b()
    s()
}`}
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
