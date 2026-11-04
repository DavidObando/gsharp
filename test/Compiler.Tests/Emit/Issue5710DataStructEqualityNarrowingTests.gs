// <copyright file="Issue5710DataStructEqualityNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Regression coverage for issue #5710 (ADR-0208 R19): structural equality (`==` and `!=`, and `==` / `!=`
/// relational patterns) on `data struct` and `inline struct` values dispatches through `Object.Equals(object, object)`
/// and can run user `Equals` overrides, invalidating narrowed mutable globals and closure-assigned locals while
/// keeping `ref`/`out` parameter narrowings under amendment A3 and primitive field comparisons.
open class Issue5710DataStructEqualityNarrowingTests {
    @Theory
    @MemberData("Rows")
    func EveryProbe_MatchesExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "issue5710-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(tempDir)
        try {
            let srcPath = Path.Combine(tempDir, name + ".gs")
            let outPath = Path.Combine(tempDir, name + ".dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
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
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            let log = compileOut.ToString() + compileErr.ToString()
            let actualDiagnostics = string.Join(
                " ",
                Regex
                    .Matches(log, `\((\d+),(\d+),\d+,\d+\): (?:error|warning) (GS\d+)`)
                    .Select((m Match) -> m.Groups[3].Value + "@" + m.Groups[1].Value + ":" + m.Groups[2].Value)
                    .Where((d string) -> !d.StartsWith("GS9100", StringComparison.Ordinal))
            )
            Assert.True(
                expectedDiagnostics == actualDiagnostics,
                "${name}: expected [${expectedDiagnostics}] but found [${actualDiagnostics}]. Log:\n${log}"
            )
            if kind == "reject" {
                Assert.False(File.Exists(outPath), "${name} must not compile. Log:\n${log}")
                return
            }
            Assert.True(File.Exists(outPath), "${name} must compile. Log:\n${log}")
            IlVerifier.Verify(outPath)
            let (exit, stdout, stderr) = RunDotnet(outPath)
            Assert.True(exit == 0, "${name} must run to completion. Exit ${exit}:\n${stderr}")
            let lines = stdout
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.NotEmpty(lines)
            Assert.Equal(expectedOutput, string.Join("|", lines))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func Rows_AreNonEmptyAndDistinct() {
        let names = Rows().Select((row[]object) -> cast[string](row[0])).ToArray()
        Assert.NotEmpty(names)
        Assert.Equal(names.Length, names.Distinct(StringComparer.Ordinal).Count())
    }

    shared {
        private const RunTimeout int32 = 30000

        public func Rows() IEnumerable[[]object] {
            yield[]object{"data_struct_equals_removes_global_fact", `import System
class C {
    var Value int32 = 1
}
class Part {
    var N int32
    override func Equals(o object?) bool {
        g = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
data struct Pair(N int32, P Part)
func Run(left Pair, right Pair) int32 {
    if g != nil {
        if left == right {
            return g.Value
        }
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Pair(1, Part{N: 1}), Pair(1, Part{N: 2})))`, "GS0158@17:22", "reject", ""}
            yield[]object{"data_struct_not_equals_removes_global_fact", `import System
class C {
    var Value int32 = 1
}
class Part {
    var N int32
    override func Equals(o object?) bool {
        g = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
data struct Pair(N int32, P Part)
func Run(left Pair, right Pair) int32 {
    if g != nil {
        if left != right {
            return 0
        }
        return g.Value
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Pair(1, Part{N: 1}), Pair(1, Part{N: 2})))`, "GS0158@19:18", "reject", ""}
            yield[]object{"data_struct_relational_equals_pattern_removes_global_fact", `import System
class C {
    var Value int32 = 1
}
class Part {
    var N int32
    override func Equals(o object?) bool {
        g = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
data struct Pair(N int32, P Part)
func Run(left Pair, right Pair) int32 {
    if g != nil {
        if left is == right {
            return g.Value
        }
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Pair(1, Part{N: 1}), Pair(1, Part{N: 2})))`, "GS0158@17:22", "reject", ""}
            yield[]object{"data_struct_relational_not_equals_pattern_removes_global_fact", `import System
class C {
    var Value int32 = 1
}
class Part {
    var N int32
    override func Equals(o object?) bool {
        g = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
data struct Pair(N int32, P Part)
func Run(left Pair, right Pair) int32 {
    if g != nil {
        if left is != right {
            return 0
        }
        return g.Value
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Pair(1, Part{N: 1}), Pair(1, Part{N: 2})))`, "GS0158@19:18", "reject", ""}
            yield[]object{"nested_data_struct_equals_removes_global_fact", `import System
class C {
    var Value int32 = 1
}
class Part {
    var N int32
    override func Equals(o object?) bool {
        g = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
data struct Pair(N int32, P Part)
data struct Outer(Inner Pair)
func Run(left Outer, right Outer) int32 {
    if g != nil {
        if left == right {
            return g.Value
        }
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Outer(Pair(1, Part{N: 1})), Outer(Pair(1, Part{N: 2}))))`, "GS0158@18:22", "reject", ""}
            yield[]object{"inline_struct_equals_removes_global_fact", `import System
class C {
    var Value int32 = 1
}
class Part {
    var N int32
    override func Equals(o object?) bool {
        g = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
inline struct Wrap(P Part)
func Run(left Wrap, right Wrap) int32 {
    if g != nil {
        if left == right {
            return g.Value
        }
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Wrap(Part{N: 1}), Wrap(Part{N: 2})))`, "GS0158@17:22", "reject", ""}
            yield[]object{"comparable_type_parameter_equals_removes_global_fact", `import System
class C {
    var Value int32 = 1
}
class Part {
    var N int32
    override func Equals(o object?) bool {
        g = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
data struct Pair(N int32, P Part)
func Same[T comparable](left T, right T) int32 {
    if g != nil {
        if left == right {
            return g.Value
        }
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Same(Pair(1, Part{N: 1}), Pair(1, Part{N: 2})))`, "GS0158@17:22", "reject", ""}
            yield[]object{"nullable_data_struct_equals_removes_closure_assigned_fact", `import System
class C {
    var Value int32 = 4
}
class Part {
    var Clear (() -> void)?
    override func Equals(o object?) bool {
        Clear?()
        return true
    }
    override func GetHashCode() int32 -> 1
}
data struct Pair(P Part)
func Run() int32 {
    var local C? = C{}
    let clear = func() { local = nil }
    let left Pair? = Pair(Part{Clear: clear})
    let right Pair? = Pair(Part{Clear: nil})
    if local != nil {
        if left == right {
            return local.Value
        }
    }
    return 0
}
Console.WriteLine(Run())`, "GS0158@21:26", "reject", ""}
            yield[]object{"loop_header_and_body_data_struct_equals_removes_global_fact", `import System
class C {
    var Value int32 = 1
}
class Part {
    var N int32
    override func Equals(o object?) bool {
        g = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
data struct Pair(N int32, P Part)
func InHeader(left Pair, right Pair) int32 {
    while g != nil && left == right {
        return g.Value
    }
    return 0
}
func InBody(left Pair, right Pair, flag bool) int32 {
    while flag {
        if g != nil {
            let same = left == right
            if same {
                return g.Value
            }
        }
        return 0
    }
    return 0
}
var g C? = C{}
Console.WriteLine(InHeader(Pair(1, Part{N: 1}), Pair(1, Part{N: 2})) + InBody(Pair(1, Part{N: 1}), Pair(1, Part{N: 2}), true))`, "GS0158@16:18 GS0158@25:26", "reject", ""}
            yield[]object{"control_primitive_field_equality_keeps_global_fact", `import System
class C {
    var Value int32 = 9
}
class Part {
    var N int32
}
data struct Pair(N int32, P Part)
func Run(left Pair, right Pair) int32 {
    if g != nil {
        if left.N == right.N && left.N is == right.N {
            return g.Value
        }
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Pair(1, Part{N: 1}), Pair(1, Part{N: 2})))`, "", "run", "9"}
            yield[]object{"control_ref_parameter_kept_across_data_struct_equality_A3", `import System
class C {
    var Value int32 = 7
}
class Part {
    var N int32
    override func Equals(o object?) bool -> true
    override func GetHashCode() int32 -> 1
}
data struct Pair(N int32, P Part)
func Run(ref c C?, left Pair, right Pair) int32 {
    if c != nil {
        if left == right && left is == right {
            return c.Value
        }
    }
    return 0
}
var item C? = C{}
Console.WriteLine(Run(ref item, Pair(1, Part{N: 1}), Pair(1, Part{N: 2})))`, "", "run", "7"}
            yield[]object{"control_nullable_data_struct_nil_equality_keeps_global_fact", `import System
class C {
    var Value int32 = 5
}
class Part {
    var N int32
    override func Equals(o object?) bool {
        g = nil
        return true
    }
    override func GetHashCode() int32 -> 1
}
data struct Pair(N int32, P Part)
func Run(left Pair?) int32 {
    if g != nil {
        if left != nil && left != default(Pair?) {
            return g.Value
        }
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Pair(1, Part{N: 1})))`, "", "run", "5"}
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Stdout string, Stderr string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) { }
                return (-1, "", "timed out after ${RunTimeout / 1000}s.")
            }
            return (process.ExitCode, stdout.GetAwaiter().GetResult(), stderr.GetAwaiter().GetResult())
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
