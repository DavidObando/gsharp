// <copyright file="Issue4961IfLetStatementGuardEmitTests.cs" company="GSharp">
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

/// Issue #4961 / ADR-0200 — end-to-end emit coverage for the aligned
/// STATEMENT form of `if let`: the optional top-level `&&` guard, the
/// left-to-right short circuit across bindings, later initializers that see
/// earlier bindings narrowed, and the statement-only control flow (`await`,
/// `yield`, closures, `break`/`continue`/`return`, top-level code, definite
/// assignment) that a statement then-block can carry. Each program is
/// compiled by the in-tree `gsc`, IL-verified, and run under
/// `dotnet exec`; stdout is compared byte for byte.
open class Issue4961IfLetStatementGuardEmitTests {
    @Fact
    func IssueRepro_GuardSeesTheBoundName() {
        // The exact shape from issue #4961, plus the nil and empty cases.
        let source = `package Repro
import System

func HasText(value string?) bool {
    if let text = value && text.Length > 0 {
        return true
    }
    return false
}

Console.WriteLine(HasText("x"))
Console.WriteLine(HasText(""))
Console.WriteLine(HasText(nil))`
        Assert.Equal(Lines("True", "False", "False"), CompileAndRun(source))
    }

    @Fact
    func Bindings_ShortCircuit_LeftToRight_AndGuardRunsOnceAfterEveryMatch() {
        let source = `package Test
import System

func A(v string?) string? {
    Console.WriteLine("A")
    return v
}
func B(v string?) string? {
    Console.WriteLine("B")
    return v
}
func G(ok bool) bool {
    Console.WriteLine("G")
    return ok
}
func Run(a string?, b string?, ok bool) {
    if let x = A(a), let y = B(b) && G(ok) {
        Console.WriteLine("then " + x + y)
    } else {
        Console.WriteLine("else")
    }
}

Run(nil, "b", true)
Run("a", nil, true)
Run("a", "b", false)
Run("a", "b", true)`
        Assert.Equal(
            Lines("A", "else", "A", "B", "else", "A", "B", "G", "else", "A", "B", "G", "then ab"),
            CompileAndRun(source)
        )
    }

    @Fact
    func NoElse_MultipleBindings_ShortCircuit() {
        let source = `package Test
import System

func A(v string?) string? {
    Console.WriteLine("A")
    return v
}
func B(v string?) string? {
    Console.WriteLine("B")
    return v
}
func Run(a string?, b string?) {
    if let x = A(a), let y = B(b) {
        Console.WriteLine(x + y)
    }
    Console.WriteLine("done")
}

Run(nil, "b")
Run("a", "b")`
        Assert.Equal(Lines("A", "done", "A", "B", "ab", "done"), CompileAndRun(source))
    }

    @Fact
    func LaterInitializer_SeesEarlierBindingNarrowed() {
        let source = `package Test
import System

func Len(s string) int32? {
    if s.Length == 0 {
        return nil
    }
    return s.Length
}
func Run(s string?) {
    if let a = s, let n = Len(a) && n > 1 {
        Console.WriteLine(a + ":" + n.ToString())
    } else {
        Console.WriteLine("no")
    }
}

Run("abc")
Run("a")
Run("")
Run(nil)`
        Assert.Equal(Lines("abc:3", "no", "no", "no"), CompileAndRun(source))
    }

    @Fact
    func ValueTypeBinding_GuardUsesUnderlyingValue() {
        let source = `package Test
import System

func Run(n int32?) {
    if let v = n && v > 0 {
        Console.WriteLine(v + 1)
    } else {
        Console.WriteLine("none")
    }
}

Run(41)
Run(0)
Run(nil)`
        Assert.Equal(Lines("42", "none", "none"), CompileAndRun(source))
    }

    @Fact
    func ElseIfLetChain_WithGuardsOnEveryLink() {
        let source = `package Test
import System

func Run(a string?, b string?) {
    if let x = a && x.Length > 2 {
        Console.WriteLine("long " + x)
    } else if let y = b && y.Length > 0 {
        Console.WriteLine("b " + y)
    } else {
        Console.WriteLine("none")
    }
}

Run("abcd", "z")
Run("ab", "z")
Run(nil, "")
Run(nil, nil)`
        Assert.Equal(Lines("long abcd", "b z", "none", "none"), CompileAndRun(source))
    }

    @Fact
    func OuterVariable_AssignedOnBothArms_IsDefinitelyAssigned() {
        let source = `package Test
import System

func One(s string?) int32 {
    var x int32
    if let v = s && v.Length > 1 {
        x = v.Length
    } else {
        x = -1
    }
    return x
}
func Two(a string?, b string?) int32 {
    var x int32
    if let p = a, let q = b && p.Length == q.Length {
        x = p.Length
    } else {
        x = -1
    }
    return x
}

Console.WriteLine(One("abc"))
Console.WriteLine(One("a"))
Console.WriteLine(Two("ab", "cd"))
Console.WriteLine(Two("ab", "c"))
Console.WriteLine(Two(nil, "c"))`
        Assert.Equal(Lines("3", "-1", "2", "-1", "-1"), CompileAndRun(source))
    }

    @Fact
    func LoopControl_AndReturn_InsideTheThenBlock() {
        let source = `package Test
import System

func First(items []string?) string {
    for item in items {
        if let s = item && s.Length == 0 {
            continue
        }
        if let s = item && s == "stop" {
            break
        }
        if let s = item && s.StartsWith("r") {
            return s
        }
        Console.WriteLine("seen " + (item ?? "nil"))
    }
    return "none"
}

Console.WriteLine(First([]string?{"a", "", nil, "rx", "b"}))
Console.WriteLine(First([]string?{"a", "stop", "rx"}))`
        Assert.Equal(Lines("seen a", "seen nil", "rx", "seen a", "none"), CompileAndRun(source))
    }

    @Fact
    func MultipleBindingsWithElse_BothArmsReturn_IsNotGS0100() {
        // ADR-0071's matched-flag lowering made this report GS0100 ("Not all
        // code paths return a value"); the shared short-circuit condition
        // gives a plain two-armed `if`.
        let source = `package Test
import System

func Run(a string?, b string?) string {
    if let x = a, let y = b {
        return x + y
    } else {
        return "none"
    }
}
func Guarded(a string?, b string?) string {
    if let x = a, let y = b && x != y {
        return x + y
    } else {
        return "same-or-nil"
    }
}

Console.WriteLine(Run("a", "b"))
Console.WriteLine(Run(nil, "b"))
Console.WriteLine(Guarded("a", "b"))
Console.WriteLine(Guarded("a", "a"))`
        Assert.Equal(Lines("ab", "none", "ab", "same-or-nil"), CompileAndRun(source))
    }

    @Fact
    func MultipleBindingsWithElse_ThenBlockCarriesClosuresYieldAndLoopControl() {
        let source = `package Test
import System
import System.Collections.Generic

func Make(a string?, b string?) () -> string {
    if let x = a, let y = b && x.Length > 0 {
        return () -> x + y
    } else {
        return () -> "none"
    }
}
func Pairs(items []string?) sequence[string] {
    for item in items {
        if let x = item, let y = item && x.Length > 1 {
            yield x + y
        } else {
            yield "-"
        }
    }
}
func FirstLong(items []string?) string {
    for item in items {
        if let x = item, let y = item && x == "skip" {
            continue
        } else if let z = item && z.Length > 2 {
            return z
        } else {
            Console.WriteLine("short " + (item ?? "nil"))
        }
    }
    return "none"
}

Console.WriteLine(Make("a", "b")())
Console.WriteLine(Make("", "b")())
for p in Pairs([]string?{"ab", nil, "c"}) {
    Console.WriteLine(p)
}
Console.WriteLine(FirstLong([]string?{"a", "skip", nil, "long"}))`
        Assert.Equal(Lines("ab", "none", "abab", "-", "-", "short a", "short nil", "long"), CompileAndRun(source))
    }

    @Fact
    func ClosureCapturesTheBinding_InsideTheThenBlock() {
        let source = `package Test
import System

func Make(s string?) () -> string {
    if let v = s && v.Length > 0 {
        return () -> v + "!"
    }
    return () -> "none"
}

Console.WriteLine(Make("hi")())
Console.WriteLine(Make("")())`
        Assert.Equal(Lines("hi!", "none"), CompileAndRun(source))
    }

    @Fact
    func AwaitInsideTheThenBlock_OfAnAsyncFunction() {
        let source = `package Test
import System
import System.Threading.Tasks

async func Echo(s string) string {
    await Task.Yield()
    return s
}
async func Run(a string?, b string?) string {
    if let x = a, let y = b && x.Length > 0 {
        let first = await Echo(x)
        return first + await Echo(y)
    } else {
        return "none"
    }
}

Console.WriteLine(Run("a", "b").Result)
Console.WriteLine(Run("", "b").Result)
Console.WriteLine(Run("a", nil).Result)`
        Assert.Equal(Lines("ab", "none", "none"), CompileAndRun(source))
    }

    @Fact
    func YieldInsideTheThenBlock_OfAnIterator() {
        let source = `package Test
import System
import System.Collections.Generic

func Lengths(items []string?) sequence[int32] {
    for item in items {
        if let s = item && s.Length > 1 {
            yield s.Length
        }
    }
}

for n in Lengths([]string?{"abc", nil, "a", "de"}) {
    Console.WriteLine(n)
}`
        Assert.Equal(Lines("3", "2"), CompileAndRun(source))
    }

    @Fact
    func TopLevelStatement_WithGuard() {
        let source = `package Test
import System

let maybe string? = "top"
if let v = maybe && v.Length == 3 {
    Console.WriteLine(v)
} else {
    Console.WriteLine("else")
}`
        Assert.Equal(Lines("top"), CompileAndRun(source))
    }

    @Fact
    func Guard_NarrowsAndBindsPatternVariables_ForTheThenRegion_InBothForms() {
        // The then-region sees the guard as an `if` branch sees its condition:
        // `&& o != nil` narrows `o`, and `&& o is string t` puts `t` in scope.
        let source = `package Test
import System

func Statement(s string?, o object?) {
    if let v = s && o is string t {
        Console.WriteLine(v + t)
    }
    if let w = s && o != nil {
        Console.WriteLine(w + o.ToString())
    }
}
func Expression(s string?, o object?) string {
    return if let v = s && o is string t { v + t } else { "none" }
}

Statement("a", "b")
Statement("a", nil)
Console.WriteLine(Expression("a", "c"))
Console.WriteLine(Expression("a", 1))`
        Assert.Equal(Lines("ab", "ab", "ac", "none"), CompileAndRun(source))
    }

    @Fact
    func ConditionalInitializer_KeepsWorking_AndAcceptsAGuard() {
        // Issue #4961 compatibility: a `?:` initializer was valid in the
        // statement form before the change and stays valid; a guard may now
        // follow it, and the parenthesized form of `a && b ? x : y` keeps
        // its old meaning.
        let source = `package Test
import System

func Plain(flag bool, x string?, y string?) {
    if let v = flag ? x : y {
        Console.WriteLine(v)
    } else {
        Console.WriteLine("nil")
    }
}
func Guarded(flag bool, x string?, y string?) {
    if let v = flag ? x : y && v.Length > 1 {
        Console.WriteLine(v)
    } else {
        Console.WriteLine("short")
    }
}
func Parenthesized(a bool, b bool, x string?, y string?) {
    if let v = (a && b ? x : y) {
        Console.WriteLine(v)
    }
}

Plain(true, "x", "y")
Plain(false, "x", nil)
Guarded(true, "xx", "y")
Guarded(false, "xx", "y")
Parenthesized(true, false, "x", "y")`
        Assert.Equal(Lines("x", "nil", "xx", "short", "y"), CompileAndRun(source))
    }

    @Fact
    func ExpressionForm_AcceptsAConditionalInitializer() {
        // Aligned initializer grammar: the value-position form used to fail
        // to parse a `?:` initializer that the statement form accepted.
        let source = `package Test
import System

func Run(flag bool, x string?, y string?) string {
    return if let v = flag ? x : y && v.Length > 0 { v } else { "none" }
}

Console.WriteLine(Run(true, "x", "y"))
Console.WriteLine(Run(false, "x", ""))
Console.WriteLine(Run(false, "x", nil))`
        Assert.Equal(Lines("x", "none", "none"), CompileAndRun(source))
    }

    shared {
        private func Lines(values ...string) string {
            return string.Join(Environment.NewLine, values) + Environment.NewLine
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4961_").FullName
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
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
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
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
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
