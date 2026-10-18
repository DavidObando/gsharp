// <copyright file="Issue4986NarrowedNullableMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #4986: a smart cast narrows `n int32?` to `int32`, which has no
/// `Value`, `HasValue` or `GetValueOrDefault`. `n != nil ? n.Value : 0`
/// compiled in 0.4.1270 and 0.5.7 because the ternary did not narrow; once it
/// did (#4964) the C# idiom stopped compiling, and the if-forms had never
/// accepted it. A member access on a narrowed value-type nullable now binds
/// against the `Nullable<T>` storage when the narrowed type has no member of
/// that name, in every narrowing region. A member the narrowed type does
/// have keeps binding to it.
///
/// Every program goes through the real driver, ilverify and a run, so a
/// read that skipped the `Nullable<T>` storage or the unwrap fails here.
open class Issue4986NarrowedNullableMemberTests {
    /// `int32?` through every narrowing form that narrows a value-type
    /// nullable: `?:` (both guards), the if-expression, the if-statement,
    /// an early return, and a `||` early exit. `&&` does not narrow a
    /// value-type nullable (#4969) and is covered to show it still binds.
    @Fact
    func Int32_Nullable_Members_Bind_In_Every_Narrowing_Form() {
        let result = CompileAndRun(`import System
func ternary(n int32?) int32 -> n != nil ? n.Value : 0
func ternaryElse(n int32?) bool -> n == nil ? false : n.HasValue
func ternaryDefault(n int32?) int32 -> n != nil ? n.GetValueOrDefault() + n.GetValueOrDefault(7) : -1
func ifExpression(n int32?) int32 -> if n != nil { n.Value * 2 } else { -1 }
func ifStatement(n int32?) string {
    if n != nil {
        return "${n.Value} ${n.HasValue} ${n.GetValueOrDefault(9)}"
    }
    return "none"
}
func earlyReturn(n int32?) int32 {
    if n == nil {
        return -1
    }
    return n.Value + n.GetValueOrDefault()
}
func orExit(n int32?, stop bool) int32 {
    if n == nil || stop {
        return -1
    }
    return n.Value + 100
}
func andGuard(n int32?) bool -> n != nil && n.Value > 0
Console.WriteLine("${ternary(3)} ${ternary(nil)} ${ternaryElse(3)} ${ternaryElse(nil)} ${ternaryDefault(4)} ${ternaryDefault(nil)}")
Console.WriteLine("${ifExpression(5)} ${ifExpression(nil)} ${ifStatement(6)} ${ifStatement(nil)}")
Console.WriteLine("${earlyReturn(7)} ${earlyReturn(nil)} ${orExit(1, false)} ${orExit(1, true)} ${andGuard(2)} ${andGuard(nil)}")
`)
        Assert.Equal(
            string.Join(Environment.NewLine, "3 0 True False 8 -1", "10 -1 6 True 6 none", "14 -1 101 -1 True False") +
                Environment.NewLine,
            result.Output
        )
    }

    /// A CLR enum and a CLR struct (`DayOfWeek?`, `TimeSpan?`) take the same
    /// path as `int32?`, including a member chained after `Value`.
    @Fact
    func Clr_Enum_And_Struct_Nullable_Members_Bind_When_Narrowed() {
        let result = CompileAndRun(`import System
func day(d DayOfWeek?) string -> d != nil ? d.Value.ToString() + "/" + d.HasValue.ToString() : "none"
func span(t TimeSpan?) int32 {
    if t != nil {
        return t.Value.Seconds + t.GetValueOrDefault().Minutes
    }
    return -1
}
func spanDefault(t TimeSpan?) int32 -> if t == nil { -1 } else { t.GetValueOrDefault(TimeSpan.Zero).Hours }
Console.WriteLine("${day(DayOfWeek.Monday)} ${day(nil)} ${span(TimeSpan(0, 2, 5))} ${span(nil)} ${spanDefault(TimeSpan(3, 0, 0))}")
`)
        Assert.Equal("Monday/True none 7 -1 3" + Environment.NewLine, result.Output)
    }

    /// A same-compilation struct and enum have no CLR type while binding.
    /// Their `Value` and `HasValue` bind against the open `Nullable<>` and
    /// emit a MemberRef parented at the constructed `Nullable<T>`, narrowed or
    /// not. (Before, `p.Value` on a user `Point?` reported GS0158 even
    /// without a guard.)
    @Fact
    func User_Struct_And_Enum_Nullable_Value_And_HasValue_Bind() {
        let result = CompileAndRun(`import System
struct Point {
    var X int32
    var Y int32
}
enum Color { Red, Green }
func plain(p Point?) int32 -> p.Value.X + (if p.HasValue { 10 } else { 0 })
func plainEnum(c Color?) bool -> c.HasValue
func ternary(p Point?) int32 -> p != nil ? p.Value.X + p.Value.Y : -1
func ternaryEnum(c Color?) bool -> c == nil ? false : c.HasValue
func ifStatement(c Color?) string {
    if c != nil {
        return c.Value.ToString()
    }
    return "none"
}
func earlyReturn(p Point?) int32 {
    if p == nil {
        return -1
    }
    return p.Value.Y
}
Console.WriteLine("${plain(Point{X: 2, Y: 3})} ${plainEnum(Color.Green)} ${plainEnum(nil)}")
Console.WriteLine("${ternary(Point{X: 2, Y: 3})} ${ternary(nil)} ${ternaryEnum(Color.Red)} ${ifStatement(Color.Green)} ${ifStatement(nil)} ${earlyReturn(Point{X: 1, Y: 7})}")
`)
        Assert.Equal(
            string.Join(Environment.NewLine, "12 True False", "5 -1 True Green none 7") + Environment.NewLine,
            result.Output
        )
    }

    /// A member the narrowed type declares itself wins: `Box` has its own
    /// `Value`, so `b.Value` in the proven branch is `Box.Value` (an
    /// `int32`), not `Nullable<Box>.Value` (a `Box`).
    @Fact
    func A_Member_Of_The_Narrowed_Type_Keeps_Binding_To_It() {
        let result = CompileAndRun(`import System
struct Box {
    var Value int32
}
func ternary(b Box?) int32 -> b != nil ? b.Value : 0
func ifStatement(b Box?) int32 {
    if b != nil {
        return b.Value + 1
    }
    return 0
}
Console.WriteLine("${ternary(Box{Value: 8})} ${ternary(nil)} ${ifStatement(Box{Value: 4})}")
`)
        Assert.Equal("8 0 5" + Environment.NewLine, result.Output)
    }

    /// The narrowed bind is tried first and rolled back when the member is
    /// missing, so an argument is bound twice. A lambda argument must still
    /// run exactly once, from the kept binding.
    @Fact
    func A_Lambda_Argument_Survives_The_Rebind() {
        let result = CompileAndRun(`import System
func run(f () -> int32) int32 {
    calls = calls + 1
    return f()
}
func pick(n int32?) int32 -> n != nil ? n.GetValueOrDefault(run(() -> 40)) : run(() -> 1)
func pickStatement(n int32?) int32 {
    if n != nil {
        return n.GetValueOrDefault(run(() -> 50)) + run(() -> 0)
    }
    return run(() -> 2)
}
var calls = 0
Console.WriteLine("${pick(2)} ${pick(nil)} ${pickStatement(3)} ${pickStatement(nil)} ${calls}")
`)
        Assert.Equal("2 1 3 2 5" + Environment.NewLine, result.Output)
    }

    /// The storage read is an ordinary `Nullable<T>.Value` property access, so
    /// it also works inside an expression-tree lambda, where the narrowed
    /// unwrap itself is rejected (#4974).
    @Fact
    func Storage_Read_Works_In_An_Expression_Tree() {
        let result = CompileAndRun(`import System
import System.Linq.Expressions
let e Expression[Func[int32?, int32]] = (v int32?) -> v != nil ? v.Value + 1 : 0
let h Expression[Func[int32?, bool]] = (v int32?) -> if v != nil { v.HasValue } else { false }
Console.WriteLine("${e.Compile()(4)} ${e.Compile()(nil)} ${h.Compile()(1)} ${h.Compile()(nil)}")
`)
        Assert.Equal("5 0 True False" + Environment.NewLine, result.Output)
    }

    shared {
        /// Compiles the program through the real driver, verifies it with
        /// ilverify, runs it and returns its standard output and the
        /// compiler's output.
        private func CompileAndRun(source string)(Output string, CompilerOutput string) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4986NarrowedNullableMemberTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue4986.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = outputDirectory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                let (sampleExit, stdout, stderr) = IlVerifier.RunProcess(startInfo, outputPath, 30_000)
                Assert.True(sampleExit == 0, (`sample exited ` + "$sampleExit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    standardOut.ToString() + standardError.ToString()
                )
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }
    }
}
