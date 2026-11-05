// <copyright file="Issue5693SourceDeconstructTests.cs" company="GSharp">
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

/// Regression coverage for issue #5693: deconstruction (`let (a, b) = p`, `var (a, b) = p`, and `for (a, b) in items`)
/// resolves accessible source-declared `Deconstruct` instance and extension methods across `struct`, `class`,
/// `interface`, and generic constructions, and treats user-declared `Deconstruct` calls as running user code in
/// narrowing analysis.
open class Issue5693SourceDeconstructTests {
    @Theory
    @MemberData("Rows")
    func EveryProbe_MatchesExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "issue5693-" + Guid.NewGuid().ToString("N"))
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
            yield[]object{"source_struct_class_and_interface_deconstruct", `import System
struct Pair {
    var A int32
    var B int32
    func Deconstruct(out a int32, out b int32) {
        a = A
        b = B
    }
}
open class BaseNode {
    var X int32
    var Y int32
    func Deconstruct(out x int32, out y int32) {
        x = X
        y = Y
    }
}
class DerivedNode : BaseNode { }
interface IPair {
    func Deconstruct(out a int32, out b int32);
}
class ImplPair : IPair {
    var Left int32
    var Right int32
    func Deconstruct(out a int32, out b int32) {
        a = Left
        b = Right
    }
}
func One(p Pair) int32 {
    let (a, b) = p
    var (x, y) = p
    let (__d0, __d1) = Pair{A: 10, B: 20}
    x = __d0
    y = __d1
    return a + b + x + y
}
func Many(items []Pair, nodes []DerivedNode, iface IPair) int32 {
    var total = 0
    for (a, b) in items {
        total += a + b
    }
    for (x, _) in nodes {
        total += x
    }
    let (l, r) = iface
    return total + l + r
}
Console.WriteLine(One(Pair{A: 3, B: 4}) + Many([]Pair{Pair{A: 1, B: 2}, Pair{A: 5, B: 6}}, []DerivedNode{DerivedNode{X: 7, Y: 8}}, ImplPair{Left: 9, Right: 11}))`, "", "run", "78"}
            yield[]object{"generic_source_box_and_interface_deconstruct", `import System
class Box[T] {
    var Value T
    var Count int32
    func Deconstruct(out value T, out count int32) {
        value = Value
        count = Count
    }
}
interface IBox[T] {
    func Deconstruct(out value T, out count int32);
}
interface IDerivedBox : IBox[string] { }
interface IDimBase {
    func Deconstruct(out a int32, out b int32) {
        a = 10
        b = 20
    }
}
interface IDimDerived : IDimBase { }
interface IDimGeneric[T] {
    func Deconstruct(out value T, out count int32) {
        value = default(T)
        count = 15
    }
}
class DimImpl : IDimDerived { }
class DimGenericImpl : IDimGeneric[int32] { }
class BoxImpl[T] : IBox[T] {
    var Item T
    var Tag int32
    func Deconstruct(out value T, out count int32) {
        value = Item
        count = Tag
    }
}
class DerivedBoxImpl : IDerivedBox {
    var Item string
    var Tag int32
    func Deconstruct(out value string, out count int32) {
        value = Item
        count = Tag
    }
}
func Constrained[T IDerivedBox](item T) string {
    let (v, n) = item
    return "${v}:${n}"
}
func Run(box Box[string], items []Box[string], iface IBox[string], derived DerivedBoxImpl, dim DimImpl, dimGen DimGenericImpl) string {
    let (head, headCount) = box
    var sum = headCount
    for (text, n) in items {
        sum += text.Length + n
    }
    let (ifaceText, ifaceCount) = iface
    let (d1, d2) = dim
    let (g1, g2) = dimGen
    return "${head}:${sum}:${ifaceText}:${ifaceCount}:${Constrained(derived)}:${d1 + d2 + g1 + g2}"
}
Console.WriteLine(Run(Box[string]{Value: "hi", Count: 2}, []Box[string]{Box[string]{Value: "abc", Count: 4}}, BoxImpl[string]{Item: "ok", Tag: 9}, DerivedBoxImpl{Item: "tp", Tag: 5}, DimImpl{}, DimGenericImpl{}))`, "", "run", "hi:9:ok:9:tp:5:45"}
            yield[]object{"source_extension_deconstruct", `import System
import System.Collections.Generic
struct Pair {
    var A int32
    var B int32
}
class Holder[T] {
    var Item T
    var Weight int32
}
data struct Point(X int32, Y int32)
func (p Pair) Deconstruct(out a int32, out b int32) {
    a = p.A
    b = p.B
}
func (h Holder[T]) Deconstruct[T](out item T, out weight int32) {
    item = h.Item
    weight = h.Weight
}
func (pt Point) Deconstruct(out x int32, out y int32, out sum int32) {
    x = pt.X
    y = pt.Y
    sum = pt.X + pt.Y
}
func (kv KeyValuePair[int32, int32]) Deconstruct(out k int32, out v int32) {
    k = -100
    v = -200
}
func Run(p Pair, items []Pair, h Holder[string], pt Point, kv KeyValuePair[int32, int32]) string {
    let (a, b) = p
    var total = a + b
    for (x, y) in items {
        total += x + y
    }
    let (text, w) = h
    let (px, py, psum) = pt
    let (k, v) = kv
    return "${total}:${text}:${w}:${px + py + psum}:${k + v}"
}
Console.WriteLine(Run(Pair{A: 2, B: 3}, []Pair{Pair{A: 4, B: 5}}, Holder[string]{Item: "ext", Weight: 7}, Point(6, 8), KeyValuePair[int32, int32](10, 20)))`, "", "run", "14:ext:7:28:30"}
            yield[]object{"byref_like_receiver_rejected_by_generic_extension_deconstruct", `import System
func (p T) Deconstruct[T](out a int32, out b int32) {
    a = 1
    b = 2
}
func Run(s Span[int32]) int32 {
    let (a, b) = s
    return 0
}
Console.WriteLine(Run(Span[int32].Empty))`, "GS0164@7:9", "reject", ""}
            yield[]object{"overloaded_deconstruct_selects_matching_arity", `import System
struct Multi {
    var A int32
    var B int32
    var C int32
    func Deconstruct(out a int32, out b int32) {
        a = A
        b = B
    }
    func Deconstruct(out a int32, out b int32, out c int32) {
        a = A
        b = B
        c = C
    }
}
struct ExtMulti {
    var X int32
    var Y int32
    var Z int32
}
func (m ExtMulti) Deconstruct(out x int32, out y int32) {
    x = m.X
    y = m.Y
}
func (m ExtMulti) Deconstruct(out x int32, out y int32, out z int32) {
    x = m.X
    y = m.Y
    z = m.Z
}
func Run(m Multi, items []Multi, em ExtMulti) int32 {
    let (a2, b2) = m
    let (a3, b3, c3) = m
    var loopSum = 0
    for (x, y, z) in items {
        loopSum += x + y + z
    }
    let (ex2, ey2) = em
    let (ex3, ey3, ez3) = em
    return a2 + b2 + a3 + b3 + c3 + loopSum + ex2 + ey2 + ex3 + ey3 + ez3
}
Console.WriteLine(Run(Multi{A: 1, B: 2, C: 3}, []Multi{Multi{A: 4, B: 5, C: 6}}, ExtMulti{X: 7, Y: 8, Z: 9}))`, "", "run", "63"}
            yield[]object{"inaccessible_private_and_protected_deconstruct_reports_gs0164", `import System
struct Secret {
    var A int32
    var B int32
    private func Deconstruct(out a int32, out b int32) {
        a = A
        b = B
    }
    func Inside() int32 {
        let (x, y) = this
        return x + y
    }
}
open class ProtectedBase {
    var A int32
    var B int32
    protected func Deconstruct(out a int32, out b int32) {
        a = A
        b = B
    }
}
func Outside(s Secret, items []Secret, b ProtectedBase) int32 {
    let (a, b1) = s
    for (x, y) in items {
    }
    let (pa, pb) = b
    return 0
}
Console.WriteLine(Outside(Secret{A: 1, B: 2}, []Secret{}, ProtectedBase{A: 3, B: 4}))`, "GS0164@23:9 GS0164@24:9 GS0164@26:9", "reject", ""}
            yield[]object{"source_deconstruct_removes_narrowed_global_fact", `import System
class Box {
    var Value int32 = 5
}
struct Pair {
    var A int32
    var B int32
    func Deconstruct(out a int32, out b int32) {
        g = nil
        a = A
        b = B
    }
}
struct ExtPair {
    var A int32
    var B int32
}
func (p ExtPair) Deconstruct(out a int32, out b int32) {
    g = nil
    a = p.A
    b = p.B
}
func StatementInstance(p Pair) int32 {
    if g != nil {
        let (a, b) = p
        return g.Value + a + b
    }
    return 0
}
func StatementExtension(p ExtPair) int32 {
    if g != nil {
        let (a, b) = p
        return g.Value + a + b
    }
    return 0
}
func LoopInstance(items []Pair) int32 {
    if g != nil {
        var total = 0
        for (a, b) in items {
            total += a + b
        }
        return g.Value + total
    }
    return 0
}
var g Box? = Box{}
Console.WriteLine(StatementInstance(Pair{A: 1, B: 2}) + StatementExtension(ExtPair{A: 1, B: 2}) + LoopInstance([]Pair{Pair{A: 1, B: 2}}))`, "GS0158@26:18 GS0158@33:18 GS0158@43:18", "reject", ""}
            yield[]object{"source_deconstruct_in_loop_removes_narrowed_ref_parameter_fact", `import System
struct Pair {
    var A int32
    var B int32
    func Deconstruct(out a int32, out b int32) {
        a = A
        b = B
    }
}
func ForRangePrelude(ref s string?, items []Pair) int32 {
    if s == nil {
        return 0
    }
    var total = 0
    for (a, b) in items {
        total += a + b
    }
    return s.Length + total
}
func LoopBodyStatement(ref s string?, items []Pair) int32 {
    if s == nil {
        return 0
    }
    var total = 0
    for var i = 0; i < items.Length; i++ {
        let (a, b) = items[i]
        total += a + b
    }
    return s.Length + total
}
var text string? = "abc"
Console.WriteLine(ForRangePrelude(ref text, []Pair{Pair{A: 1, B: 2}}) + LoopBodyStatement(ref text, []Pair{Pair{A: 3, B: 4}}))`, "GS0158@18:14 GS0158@29:14", "reject", ""}
            yield[]object{"control_data_struct_deconstruct_keeps_global_and_ref_facts", `import System
class Box {
    var Value int32 = 5
}
data struct DataPair(A int32, B int32)
func KeepGlobal(p DataPair) int32 {
    if g != nil {
        let (a, b) = p
        return g.Value + a + b
    }
    return 0
}
func KeepRefInForRange(ref s string?, items []DataPair) int32 {
    if s == nil {
        return 0
    }
    var total = 0
    for (_, _) in items {
        total += 1
    }
    return s.Length + total
}
var g Box? = Box{}
var text string? = "abc"
Console.WriteLine(KeepGlobal(DataPair(2, 3)) + KeepRefInForRange(ref text, []DataPair{DataPair(4, 5)}))`, "", "run", "14"}
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
