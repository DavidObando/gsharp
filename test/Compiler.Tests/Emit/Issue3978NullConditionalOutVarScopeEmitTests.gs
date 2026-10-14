// <copyright file="Issue3978NullConditionalOutVarScopeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3978: an inline `out var` argument inside a NULL-CONDITIONAL
/// access must bind in the scope enclosing the call, exactly as it does when
/// the receiver is spelled `receiver!!.`.
///
/// `BindNullConditionalAccessExpressionCore` pushes a temporary scope to
/// hold the synthetic `$ncap_N` capture local and popped it wholesale
/// after binding the right part, which threw away every declaration the right
/// part had made. `lookup?.TryGetValue(k, out var found) == true`
/// therefore reported `GS0125 Variable 'found' doesn't exist` at every
/// later reference, while the `!!` spelling of the same call compiled.
///
/// These tests EXECUTE the emitted assembly rather than only binding it: the
/// risk of hoisting a declaration out of a scope is that the local is emitted
/// but never assigned on the short-circuit path, which binds clean and then
/// reads garbage (or fails ilverify) at run time. The nil-receiver case below
/// is the one that pins that down.
open class Issue3978NullConditionalOutVarScopeEmitTests {
    @Fact
    func ConditionalAccess_InlineOutVar_IsVisibleAfterTheCall() {
        // Hit, miss-on-empty and nil-receiver in one program. The nil case
        // proves `?.` still short-circuits: the call never runs, so the
        // condition is nil (not `true`) and the binding is simply not taken.
        let source = `package P
import System
import System.Collections.Generic

func probe(lookup Dictionary[string, int32]?) string {
    if lookup?.TryGetValue("k", out var found) == true {
        return "hit:" + found.ToString()
    }
    return "miss"
}

let live = Dictionary[string, int32]()
live["k"] = 7
Console.WriteLine(probe(live))
Console.WriteLine(probe(Dictionary[string, int32]()))
Console.WriteLine(probe(nil))`
        let output = CompileAndRun(source)
        Assert.Equal("hit:7${Environment.NewLine}miss${Environment.NewLine}miss${Environment.NewLine}", output)
    }

    @Fact
    func ConditionalAccess_InlineOutVar_MatchesTheBangBangSpelling() {
        // The whole defect was that the RECEIVER SPELLING moved the binding.
        // Both spellings of the same call must produce the same result.
        let source = `package P
import System
import System.Collections.Generic

let d = Dictionary[string, string]()
d["a"] = "alpha"

let viaAssertion = d!!.TryGetValue("a", out var asserted)
Console.WriteLine(viaAssertion)
Console.WriteLine(asserted)

let nullable Dictionary[string, string]? = d
if nullable?.TryGetValue("a", out var conditional) == true {
    Console.WriteLine(conditional)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}alpha${Environment.NewLine}alpha${Environment.NewLine}", output)
    }

    @Fact
    func ConditionalAccess_InlineOutVar_SurvivesTheTranslatedSelfMigrationShape() {
        // The exact shape cs2gs emitted for tools/cs2gs/Cs2Gs.Pipeline's
        // TranslateStage after #3972: an `out var` inside a `?.` call that is
        // the last conjunct of an `&&` chain, consumed twice in the body.
        let source = `package P
import System
import System.Collections.Generic

func transform(
    enabled bool,
    moniker string,
    paths Dictionary[string, string]?,
    key string) string {
    if enabled &&
        !string.IsNullOrEmpty(moniker) &&
        paths?.TryGetValue(key, out var generatedProjectPath) == true {
        return generatedProjectPath + "|" + generatedProjectPath
    }
    return "skipped"
}

let paths = Dictionary[string, string]()
paths["p"] = "gen"
Console.WriteLine(transform(true, "sdk", paths, "p"))
Console.WriteLine(transform(true, "sdk", paths, "absent"))
Console.WriteLine(transform(false, "sdk", paths, "p"))
Console.WriteLine(transform(true, "", paths, "p"))
Console.WriteLine(transform(true, "sdk", nil, "p"))`
        let output = CompileAndRun(source)
        Assert.Equal(
            "gen|gen${Environment.NewLine}skipped${Environment.NewLine}skipped${Environment.NewLine}" +
                "skipped${Environment.NewLine}skipped${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue3978_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
