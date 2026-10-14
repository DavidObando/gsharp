// <copyright file="Issue903SameCompilationLambdaInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #903 — an un-typed arrow lambda passed to a generic LINQ extension
/// method (`Single`/`Where`/`Select`/…) whose receiver's generic
/// element type is a <em>same-compilation</em> user type (a `struct` or
/// `class` being compiled, e.g. `List[Check]` where
/// `Check` is declared in the same source) must infer its parameter type
/// from that element symbol, resolve the call, and emit verifiable, runnable IL.
///
/// On the base compiler the lambda parameter could not be inferred because the
/// element type has no CLR (cref:Type) yet (it is still being compiled),
/// so the reflection-driven inference path lost the `Check` identity and
/// reported `GS0159` (cannot find function) plus `GS0304` (cannot infer
/// lambda parameter). The fix recovers the element type <em>symbolically</em>
/// from the receiver's `TypeArguments` for parameter inference, the call's
/// return type, and the emitted MethodSpec — so a value-type element no longer
/// produces a fatal `unbox.any` over a struct value on the stack.
///
/// These cases all construct elements via object initializers on `let`
/// (read-only) fields. That lowering sets an init-only field outside the
/// declaring type's constructor, which ilverify flags as `InitOnly`. That
/// behaviour is a pre-existing, unrelated G# object-initializer limitation (it
/// reproduces for a plain `Check { Id: "x" }` with no LINQ at all), so the
/// verification gate ignores only that code while still catching any new IL
/// regression introduced by this fix (e.g. `StackObjRef` from a bad
/// value-type erasure).
open class Issue903SameCompilationLambdaInferenceEmitTests {
    @Fact
    func Struct_UntypedLambda_Single_InfersElementAndRuns() {
        // The exact issue repro: Single with an un-typed predicate whose body
        // reads a member of the same-compilation struct element.
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

struct CheckSS {
    let Id string
}

let checks = List[CheckSS]()
checks.Add(CheckSS { Id: "audible-api" })
checks.Add(CheckSS { Id: "network" })

let net = checks.Single((c) -> c.Id == "network")
Console.WriteLine(net.Id)`
        Assert.Equal("network${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Struct_UntypedLambda_SelectProjectingToString_InfersAndRuns() {
        // The second issue repro: Select projecting to a different type (string)
        // so TResult is inferred from the body, then ToHashSet over the result.
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

struct CheckSSel {
    let Id string
}

let checks = List[CheckSSel]()
checks.Add(CheckSSel { Id: "audible-api" })
checks.Add(CheckSSel { Id: "network" })

let ids = checks.Select((c) -> c.Id).ToHashSet()
Console.WriteLine(ids.Count)`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Struct_UntypedLambda_WhereThenToList_InfersAndRuns() {
        // Where returns IEnumerable[Check]; the chained ToList must keep the
        // Check element identity (a value-type element cannot up-cast to
        // IEnumerable<object>) and instantiate ToList<Check>.
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

struct CheckSWhere {
    let Id string
}

let checks = List[CheckSWhere]()
checks.Add(CheckSWhere { Id: "audible-api" })
checks.Add(CheckSWhere { Id: "network" })

let filtered = checks.Where((c) -> c.Id == "network").ToList()
Console.WriteLine(filtered.Count)
Console.WriteLine(filtered.Single((c) -> true).Id)`
        Assert.Equal("1${Environment.NewLine}network${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Struct_UntypedLambda_SelectWithIndex_InfersAndRuns() {
        // The two-parameter (element, index) Select overload must behave like
        // the explicitly-typed parameter form.
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

struct CheckSIdx {
    let Id string
}

let checks = List[CheckSIdx]()
checks.Add(CheckSIdx { Id: "audible-api" })
checks.Add(CheckSIdx { Id: "network" })

let indices = checks.Select((c, i) -> i).ToList()
Console.WriteLine(indices.Count)`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Class_UntypedLambda_Single_InfersElementAndRuns() {
        // Reference-type element variant: the same recovery must instantiate
        // Single<Check> (the redundant erased object cast is also suppressed).
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

class CheckCS {
    let Id string
}

let checks = List[CheckCS]()
checks.Add(CheckCS { Id: "audible-api" })
checks.Add(CheckCS { Id: "network" })

let net = checks.Single((c) -> c.Id == "network")
Console.WriteLine(net.Id)`
        Assert.Equal("network${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Class_UntypedLambda_WhereThenToList_InfersAndRuns() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

class CheckCWhere {
    let Id string
}

let checks = List[CheckCWhere]()
checks.Add(CheckCWhere { Id: "audible-api" })
checks.Add(CheckCWhere { Id: "network" })

let filtered = checks.Where((c) -> c.Id == "audible-api").ToList()
Console.WriteLine(filtered.Count)`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Class_UntypedLambda_SelectProjectingToString_InfersAndRuns() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

class CheckCSel {
    let Id string
}

let checks = List[CheckCSel]()
checks.Add(CheckCSel { Id: "audible-api" })
checks.Add(CheckCSel { Id: "network" })

let ids = checks.Select((c) -> c.Id).ToHashSet()
Console.WriteLine(ids.Count)`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Struct_ExplicitlyTypedLambda_Single_StillRuns() {
        // The explicitly-typed parameter form must remain correct (and must
        // also emit Single<Check>, not a value-type-erasing object close).
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

struct CheckSExpl {
    let Id string
}

let checks = List[CheckSExpl]()
checks.Add(CheckSExpl { Id: "audible-api" })
checks.Add(CheckSExpl { Id: "network" })

let net = checks.Single((c CheckSExpl) -> c.Id == "network")
Console.WriteLine(net.Id)`
        Assert.Equal("network${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue903_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // Issue #903: ignore the pre-existing, unrelated InitOnly diagnostic
                // produced by object initializers on `let` fields (reproduces with no
                // LINQ at all). The gate still catches any NEW IL regression — most
                // importantly a value-type StackObjRef/StackUnexpected from a faulty
                // type-erased LINQ emit.
                IlVerifier.Verify(
                    outPath,
                    ignoredErrorCodes: []string{"InitOnly"},
                    ignoredErrorScope: "<Program>\\.<Main>\\$$$$"
                )
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // Best-effort cleanup; ignore failures.

                }
            }
        }
    }
}
