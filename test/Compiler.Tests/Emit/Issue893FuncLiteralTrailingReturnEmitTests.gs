// <copyright file="Issue893FuncLiteralTrailingReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #893 — a value-returning function literal
/// `func(p T) R { ... <trailing-expr> }` whose block body ends in a bare
/// trailing expression must treat that expression as the implicit return value.
///
/// Before the fix the trailing expression bound to a discarded expression
/// statement, so the emitted method had a non-void signature but no `ret`
/// returning a value. The CLR rejected the body with
/// `System.InvalidProgramException` at runtime (and ilverify flagged the
/// invalid IL). This was most visible when such a literal was passed as a
/// `Func<TSource,bool>` predicate to a generic LINQ method like
/// `Single` / `Where`, exactly as in the issue's
/// `report.Checks.Single(func(c DoctorCheck) bool { c.Id == "audible-api" })`.
open class Issue893FuncLiteralTrailingReturnEmitTests {
    @Fact
    func FuncLiteralPredicate_TrailingBoolExpression_AsLinqSinglePredicate_Runs() {
        // Faithful shape of the issue: a `func(c T) bool { <comparison> }` literal
        // passed straight to LINQ Single<TSource>(IEnumerable<TSource>, Func<TSource,bool>).
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

let ids = List[string]()
ids.Add("audible-api")
ids.Add("network")
let net = ids.Single(func(c string) bool { c == "network" })
Console.WriteLine(net)`
        Assert.Equal("network${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FuncLiteralPredicate_TrailingBoolExpression_AsLinqWherePredicate_Runs() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

let nums = List[int32]()
nums.Add(1)
nums.Add(2)
nums.Add(3)
nums.Add(4)
let evens = nums.Where(func(n int32) bool { n % 2 == 0 })
Console.WriteLine(evens.Count())`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FuncLiteral_TrailingExpression_WithPrefixStatements_ReturnsTrailingValue() {
        // A multi-statement block whose final statement is a bare expression: the
        // prefix statements run, then the trailing expression is the return value.
        let source = `package P
import System

let doubleThenAddOne = func(x int32) int32 {
    let doubled = x * 2
    doubled + 1
}
Console.WriteLine(doubleThenAddOne(20))`
        Assert.Equal("41${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FuncLiteral_TrailingExpression_RequiringConversion_ReturnsConvertedValue() {
        // The trailing expression's type (int32) differs from the declared return
        // type (int64); it must be converted on the synthesized return.
        let source = `package P
import System

let widen = func(x int32) int64 { x + 1 }
Console.WriteLine(widen(41))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FuncLiteral_TrailingExpression_InsideAsyncMethod_ClosureContext_Runs() {
        // Mirrors the issue's setting: the predicate literal is created inside an
        // async function and captures an outer local (closure context), then is
        // passed to LINQ Single. Exercises the trailing-return rewrite for a
        // value-returning literal that lives in a state machine / display class.
        let source = `package P
import System
import System.Linq
import System.Collections.Generic
import System.Threading.Tasks

async func findAsync(items List[string], wanted string) string {
    await Task.Yield()
    return items.Single(func(c string) bool { c == wanted })
}

let data = List[string]()
data.Add("audible-api")
data.Add("network")
data.Add("disk")
let found = findAsync(data, "network").GetAwaiter().GetResult()
Console.WriteLine(found)`
        Assert.Equal("network${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FuncLiteral_VoidBody_StatementOnly_StillRunsWithoutImplicitReturn() {
        // Regression guard for issue #889: a void function literal (Action-style)
        // must NOT gain an implicit value return from its trailing expression
        // statement; it stays a statement body.
        let source = `package P
import System

let act = func(s string) { Console.WriteLine(s) }
act("ok")`
        Assert.Equal("ok${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FuncLiteral_ExplicitReturn_StillRuns() {
        // A value-returning literal that already ends in an explicit `return` must
        // be left untouched by the trailing-return rewrite.
        let source = `package P
import System

let pick = func(flag bool) int32 {
    if flag {
        return 1
    }
    return 2
}
Console.WriteLine(pick(true))
Console.WriteLine(pick(false))`
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue893_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
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
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // (a) Static verification: the emitted IL must be valid.
                IlVerifier.Verify(outPath)
                // (b) Dynamic verification: the emitted code must execute without an
                // InvalidProgramException (the runtime symptom in issue #893).
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
                } catch { }
            }
        }
    }
}
