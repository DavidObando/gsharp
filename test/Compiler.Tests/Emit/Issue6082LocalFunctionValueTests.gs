package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Core.Tests
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.RegularExpressions
import Xunit
import Xunit.Abstractions

open class Issue6082LocalFunctionValueTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData("read", "var value = 42", "return value.ToString()", "value.ToString()", "42:42")
    @InlineData("variable-write", "var value = 0", "value = 42\nreturn \"done\"", "value.ToString()", "done:42")
    @InlineData("mutable-function", "var value = func() string { return \"42\" }", "return value()", "value()", "42:42")
    @InlineData(
        "capturing-function",
        "var offset = 42\nlet value = func() string { return offset.ToString() }",
        "return value()",
        "value()",
        "42:42"
    )
    @InlineData(
        "typed-function",
        "let value () -> string = func() string { return \"42\" }",
        "return value()",
        "value()",
        "42:42"
    )
    @InlineData(
        "index-write",
        "var value = []int32{0}",
        "value[0] = 42\nreturn \"done\"",
        "value[0].ToString()",
        "done:42"
    )
    @InlineData(
        "field-write",
        "let value = Holder()",
        "value.Value = 42\nreturn \"done\"",
        "value.Value.ToString()",
        "done:42"
    )
    @InlineData(
        "clr-index-write",
        "let value = Dictionary[int32, int32]()",
        "value[0] = 42\nreturn \"done\"",
        "value[0].ToString()",
        "done:42"
    )
    func NestedCapturingCandidates_DoNotMultiplyBindingWork(
        name string,
        setup string,
        leaf string,
        readback string,
        expected string
    ) {
        let allocations = List[int64]()
        for limit in[]int32{4, 4, 8, 12} {
            var body = leaf
            for var depth = 0; depth < limit; depth++ {
                body = "let helper$depth = func() string {\n$body\n}\n" +
                    "let next$depth = func() string { return helper$depth() }\nreturn next$depth()"
            }
            allocations.Add(
                CompileAndRun(
                    "nested-capture-planning-is-bounded-$name-$limit",
                    "class Holder { public var Value int32 }",
                    setup +
                        "\nlet start = func() string {\n" +
                        body +
                        "\n}\nlet status = start()\n" +
                        "return status + \":\" + " +
                        readback,
                    expected,
                    true
                )
            )
        }
        // The first compilation warms the same source shape and reference imports.
        allocations.RemoveAt(0)
        Assert.True(
            allocations[2] - allocations[1] < Math.Max(allocations[1] - allocations[0], 1024 * 1024) * 6,
            "Nested allocation curve (depth 4/8/12): " + string.Join(", ", allocations)
        )
    }

    @Fact
    func CapturingCallbacks_RetryCacheWorkGrowsWithWrites() {
        using let contract = CSharpFixture(`using System;
namespace CallbackControl;
public static class CallbackContract {
    public static string Pick(Func<int> value, int rank) => "wrong";
    public static string Pick(object value, long rank) => ((Func<string>)value)();
}`, assemblyName: "Issue6082Callbacks", deterministic: true)
        let growth = List[float64]()
        for retried in[]bool{false, true} {
            let allocations = List[int64]()
            for count in[]int32{4, 64, 256, 1024} {
                var body = "var offset = 42\nlet helper0 = func() string { return offset.ToString() }\n"
                for var index = 1; index < count; index++ {
                    body += "let helper$index = func() string { return helper0() }\n"
                }
                let last = count - 1
                body += if retried {
                    "helper$last()"
                } else {
                    "return helper$last()"
                }
                if retried {
                    body = "return CallbackContract.Pick(() -> { return {\n$body\n} }, 1)"
                }
                let allocated = CompileAndRun(
                    "callback-count-$retried-$count",
                    "",
                    body,
                    "42",
                    true,
                    reference: contract.AssemblyPath
                )
                if count > 4 {
                    allocations.Add(allocated)
                }
            }
            Assert.True(allocations[1] > allocations[0], string.Join(", ", allocations))
            growth.Add(float64(allocations[2] - allocations[1]) / (allocations[1] - allocations[0]))
        }
        Assert.True(
            growth[1] < growth[0] * 1.05,
            "Retry-cache allocation curvature exceeds the ordinary-callback control: " + string.Join(", ", growth)
        )
    }

    @Theory
    @MemberData("Cases")
    func OrdinaryClosures_RetainFunctionValues(
        name string,
        declarations string,
        body string,
        expected string,
        verifyIl bool
    ) {
        CompileAndRun(name, declarations, body, expected, verifyIl)
    }

    @Fact
    func CaptureFreeInnerSameSignature_WithOuterCallable_StillReportsGS0266() {
        const source = `package Issue6082
func later(n int32) int32 { return n + 100 }
shared class Probe {
    func Run() int32 {
        let helper = func(x int32) int32 { return x }
        let later = func(x int32) int32 { return helper(x + 1) }
        return later(41)
    }
}`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(source, "Issue6082CaptureFreeShadow", executable: false)
        Assert.NotEqual(0, code)
        let error = Assert.Single(Regex.Matches(output, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`))
        Assert.Equal("GS0266", error.Groups[5].Value)
        Assert.Equal("7", error.Groups[1].Value)
    }

    private func CompileAndRun(
        name string,
        declarations string,
        body string,
        expected string,
        verifyIl bool,
        reference string? = nil
    ) int64 {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue-6082", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let source = Path.Combine(directory, name + ".gs")
            let assembly = Path.Combine(directory, name + ".dll")
            let referenceImport = if reference != nil {
                "import CallbackControl\n"
            } else {
                ""
            }
            File.WriteAllText(source, `package Issue6082
import System
import System.Collections.Generic
import System.Linq
` + referenceImport + declarations + `
shared class Probe {
    func Run() string {
` + body + `
    }
}`)
            let arguments = List[string](){"/target:library", "/targetframework:net10.0", "/out:" + assembly, source}
            if reference is {} path {
                arguments.Add("/reference:" + path)
                File.Copy(path, Path.Combine(directory, Path.GetFileName(path)))
            }
            let before = GC.GetAllocatedBytesForCurrentThread()
            let start = Stopwatch.GetTimestamp()
            let result = Program.Main(arguments.ToArray())
            let allocated = GC.GetAllocatedBytesForCurrentThread() - before
            let ticks = Stopwatch.GetTimestamp() - start
            output.WriteLine(
                "$name: allocated=$allocated elapsedTicks=$ticks frequency=" + Stopwatch.Frequency.ToString()
            )
            Assert.Equal(0, result)
            // ILVerify does not implement calli. Function-pointer cases execute the emitted method instead.
            if verifyIl {
                if reference is {} path {
                    IlVerifier.Verify(assembly, []string{path})
                } else {
                    IlVerifier.Verify(assembly)
                }
            }
            let emitted = EmittedFixture.Load(assembly)
            Assert.Equal(expected, emitted.GetType("Issue6082.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
            return allocated
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        func Cases() sequence[[]object] {
            yield []object{"escaped-declaration-forward-call", "", `
        var calls = 0
        let first = func(n int32) int32 { return second(n) }
        let $second = func(n int32) int32 {
            calls++
            return n + 1
        }
        let last = func(n int32) int32 { return first(n) }
        let result = last(41)
        let next = last(0)
        return "$result:$next:$calls"
`, "42:1:2", true}
            yield []object{"escaped-reference-forward-call", "", `
        var calls = 0
        let first = func(n int32) int32 { return $second(n) }
        let second = func(n int32) int32 {
            calls++
            return n + 1
        }
        let last = func(n int32) int32 { return first(n) }
        let result = last(41)
        let next = last(0)
        return "$result:$next:$calls"
`, "42:1:2", true}
            yield []object{"escaped-declaration-forward-value", "", `
        let first = func(n int32) int32 {
            let forward Func[int32, int32] = second
            return forward(n)
        }
        let $second = func(n int32) int32 { return n + 1 }
        let last = func(n int32) int32 { return first(n) }
        return "${last(41)}:${last(0)}"
`, "42:1", true}
            yield []object{"planned-method-preserves-parent-overload", "", `
        let first = func(n int32) int32 {
            let second = func(value int32, tag int32) int32 { return 0 }
            let follow = func(value int32) int32 { return second(value, 0) }
            return second(n)
        }
        let second = func(n int32) int32 { return n + 1 }
        return first(41).ToString()
`, "42", true}
            yield []object{"backward-overload-does-not-widen-forward-region", "", `
        var calls = 0
        let first = func(n int32) int32 { return n + 1 }
        let callback = func(n int32) int32 {
            calls++
            return first(n)
        }
        let first = func(n int32, other int32) int32 { return n + other }
        let next = func(n int32) int32 { return callback(n) }
        let alias = callback
        let result = List[int32](){41}.Select(callback).Single()
        let following = next(0)
        return "$result:$following:$calls:${Object.ReferenceEquals(callback, alias)}"
`, "42:1:2:True", true}
            yield []object{"qualified-member-keeps-capture-free-method-identity", `
class Holder { shared { func second() int32 { return 42 } } }
`, `
        let before = GC.GetAllocatedBytesForCurrentThread()
        let first = func() int32 { return Holder.second() }
        let second = func() int32 { return 0 }
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        return "${first()}:$allocated"
`, "42:0", true}
            yield []object{"inner-callable-forward-overload", "", `
        let first = func(n int32) int32 {
            let second[T] = func(value T, tag int32) int32 { return 0 }
            return second(n)
        }
        let second = func(n int32) int32 { return n + 1 }
        return first(41).ToString()
`, "42", true}
            yield []object{"inner-callable-forward-optional-overload", "", `
        let first = func(n int32) int32 {
            let second[T] = func(value T, tag int32) int32 { return 0 }
            return second(n)
        }
        let second = func(n int32, unused int32 = 0) int32 { return n + 1 }
        return first(41).ToString()
`, "42", true}
            yield []object{"inner-callable-forward-empty-variadic-overload", "", `
        let first = func(n int32) int32 {
            let second[T] = func(value T, tag int32) int32 { return 0 }
            return second(n)
        }
        let second = func(n int32, rest ...int32) int32 { return n + 1 }
        return first(41).ToString()
`, "42", true}
            yield []object{"inner-callable-forward-expanded-variadic-overload", "", `
        let first = func(n int32) int32 {
            let second[T] = func(value T, tag int32) int32 { return 0 }
            return second(n, 0, 0)
        }
        let second = func(n int32, rest ...int32) int32 { return n + 1 }
        return first(41).ToString()
`, "42", true}
            for variation in[](Name string, Literal string){("capturing-function-value", `func(n int32) int32 {
                calls++
                let later = func(x int32) int32 { return n + x + 1 }
                return first(later(0))
            }`), ("local", `func(n int32) int32 {
                    calls++
                    let later = n + 1
                    return first(later)
                }`), ("parameter", `func(later int32) int32 {
                    calls++
                    return first(later + 1)
                }`), ("enclosing-local", `func(n int32) int32 {
                    calls++
                    let later = n + 1
                    let inner = func() int32 { return later }
                    return first(inner())
                }`), ("nested-forward-run", `func(n int32) int32 {
                    calls++
                    let inner = func() int32 { return later() }
                    let later = func() int32 { return n + 1 }
                    return first(inner())
                }`), ("qualified-member", `func(n int32) int32 {
                    calls++
                    return first(holder.later(n))
                }`), ("nested-conditional-capturing-value", `func(n int32) int32 {
                    calls++
                    let helper = func(x int32) int32 { return x }
                    let later = func(x int32) int32 { return helper(n + x + 1) }
                    return first(later(0))
                }`), ("nested-self-recursive-capturing-value", `func(n int32) int32 {
                    calls++
                    let helper = func(x int32) int32 { return x }
                    let later = func(x int32) int32 {
                        if x == 0 { return helper(n + 1) }
                        return later(x - 1)
                    }
                    return first(later(1))
                }`)} {
                yield []object{"shadowed-forward-" + variation.Name, `
class Holder { func later(n int32) int32 { return n + 1 } }
`, `
        var calls = 0
        let holder = Holder()
        let first = func(n int32) int32 { return n + 1 }
        let callback = ` + variation.Literal + `
        let later = func(n int32) int32 { return first(n) }
        let next = func(n int32) int32 { return callback(n) }
        let alias = callback
        let result = List[int32](){40}.Select(callback).Single()
        let following = next(0)
        return "$result:$following:$calls:${Object.ReferenceEquals(callback, alias)}"
`, "42:2:2:True", true}
            }
            yield []object{"shadowed-local-address-keeps-closure-value", `
func Bump(ref value int32) { value++ }
`, `
        var calls = 0
        let first = func(n int32) int32 { return n + 1 }
        let callback = func(n int32) int32 {
            calls++
            var callback = n
            Bump(&callback)
            return first(callback)
        }
        let next = func(n int32) int32 { return callback(n) }
        let alias = callback
        let result = List[int32](){40}.Select(callback).Single()
        let following = next(0)
        return "$result:$following:$calls:${Object.ReferenceEquals(callback, alias)}"
`, "42:2:2:True", true}
            yield []object{"shadowed-function-address-keeps-closure-value", "", `
        var calls = 0
        let first = func(n int32) int32 { return n + 1 }
        let callback = func(n int32) int32 {
            calls++
            let callback = func(m int32) int32 { return m + 1 }
            let after = func(m int32) int32 { return callback(m) }
            unsafe {
                let pointer = &callback
                return first(pointer(n))
            }
        }
        let next = func(n int32) int32 { return callback(n) }
        let alias = callback
        let result = List[int32](){40}.Select(callback).Single()
        let following = next(0)
        return "$result:$following:$calls:${Object.ReferenceEquals(callback, alias)}"
`, "42:2:2:True", false}
            yield []object{"private-generic-owner-backward-helper", `
class Holder[Outer] {
    shared {
        private func Secret() int32 { return 42 }
        func Run() int32 {
            let helper = func() int32 { return Holder[int32].Secret() }
            let next = func() int32 { return helper() }
            return next()
        }
    }
}
`, `
        return Holder[string].Run().ToString()
`, "42", true}
            yield []object{"nested-capturing-overload-reconciles-singleton", `
func helper(value string) int32 { return 42 }
`, `
        var calls = 0
        let helper = func(value object) int32 {
            let recurse = func(n int32) int32 {
                if n == 0 { return helper(cast[object]("answer")) }
                return recurse(n - 1)
            }
            calls++
            if calls > 2 { return -1 }
            if value is string { return helper("answer") }
            return recurse(1)
        }
        let next = func(n int32) int32 { return helper(n) }
        let answer = next(0)
        return "$answer:$calls"
`, "42:2", true}
            yield []object{"recursive-local-preserves-outer-overload", `
func helper(value string) int32 { return 42 }
`, `
        let helper = func(value object) int32 {
            if value is string { return 7 }
            return helper("answer")
        }
        let next = func(n int32) int32 { return helper(n) }
        return next(0).ToString()
`, "42", true}
            yield []object{"generic-async-backward-helper", `
func Keep[T](value T) T {
    let helper = async func(item T, n int32) T {
        if n == 0 { return item }
        return await helper(item, n - 1)
    }
    let next = async func(item T) T { return await helper(item, 1) }
    return next(value).GetAwaiter().GetResult()
}
`, `
        return Keep(42).ToString()
`, "42", true}
            yield []object{"capturing-recursion-preserves-outer-overload", `
func helper(value string) int32 { return 42 }
`, `
        var calls = 0
        let helper = func(value object) int32 {
            if value is string { return 7 }
            calls++
            return helper("answer")
        }
        let next = func(n int32) int32 { return helper(n) }
        let answer = next(0)
        return "$answer:$calls"
`, "42:1", true}
            yield []object{"issue-repro", `
class B {
    func F(xs List[int], set HashSet[int]) bool {
        let A = func(n int) bool { return set.Contains(n) }
        let C = func(n int) bool { return n == 0 || A(n) }
        return xs.Any(C)
    }
}
`, `
        let b = B()
        let set = HashSet[int](){2}
        return "${b.F(List[int](){0}, set)}:${b.F(List[int](){1}, set)}:${b.F(List[int](){1, 2}, set)}"
`, "True:False:True", true}
            yield []object{"backward-chain-and-later-sibling", "", `
        var calls = 0
        var target = 2
        let A = func(n int) bool {
            calls++
            return n == target
        }
        let C = func(n int) bool { return n == 0 || A(n) }
        let D = func(n int) int { return calls + n }
        let alias = C
        let zero = List[int](){0}.Any(C)
        let hit = List[int](){1, 2, 3}.Any(C)
        target = 3
        let miss = alias(2)
        let changed = alias(3)
        let read = List[int](){5}.Select(D).Single()
        return "$zero:$hit:$miss:$changed:$calls:$read:${Object.ReferenceEquals(C, alias)}:${Object.ReferenceEquals(C, C)}"
`, "True:True:False:True:4:9:True:True", true}
            yield []object{"callback-before-forward-group", "", `
        var calls = 0
        let before = func(n int) int { return calls + n }
        let first = func(n int) int {
            if n == 0 {
                calls++
                return before(0)
            }
            return second(n - 1)
        }
        let second = func(n int) int {
            if n == 0 {
                calls++
                return before(0)
            }
            return first(n - 1)
        }
        let callback = before
        let a = first(2)
        let b = List[int](){4}.Select(before).Single()
        let c = second(1)
        return "$a:$b:$c:${callback(4)}"
`, "1:5:2:6", true}
            yield []object{"callback-after-transitive-forward-group", "", `
        var calls = 0
        let first = func(n int) int { return second(n) }
        let second = func(n int) int { return third(n) }
        let third = func(n int) int {
            if n == 0 {
                calls++
                return calls
            }
            return first(n - 1)
        }
        let after = func(n int) int { return calls + n }
        let callback = after
        let a = first(2)
        let b = List[int](){4}.Select(after).Single()
        let c = third(1)
        return "$a:$b:$c:${callback(4)}"
`, "1:5:2:6", true}
            yield []object{"backward-chain-first-pointer", "", `
        let first = func(n int32) int32 { return n + 1 }
        let second = func(n int32) int32 { return first(n) }
        unsafe {
            let fp = &first
            return "${fp(41)}"
        }
`, "42", false}
            yield []object{"backward-chain-second-pointer", "", `
        let first = func(n int32) int32 { return n + 1 }
        let second = func(n int32) int32 { return first(n) }
        unsafe {
            let fp = &second
            return "${fp(41)}"
        }
`, "42", false}
            yield []object{"pointer-chain-with-capturing-callback", "", `
        var calls = 0
        let first = func(n int32) int32 { return n + 1 }
        let second = func(n int32) int32 { return first(n) }
        let callback = func(n int32) int32 {
            calls++
            return second(n)
        }
        let alias = callback
        unsafe {
            let fp = &second
            let result = fp(41)
            let mapped = List[int32](){1, 2}.Select(callback).Sum()
            return "$result:$mapped:$calls:${Object.ReferenceEquals(callback, alias)}"
        }
`, "42:5:2:True", false}
            yield []object{"pointer-chain-with-interleaved-callback", "", `
        var calls = 0
        let first = func(n int32) int32 { return n + 1 }
        let callback = func(n int32) int32 {
            calls++
            return first(n)
        }
        let second = func(n int32) int32 { return first(n) }
        let alias = callback
        unsafe {
            let fp = &second
            let result = fp(41)
            let mapped = List[int32](){1, 2}.Select(callback).Sum()
            return "$result:$mapped:$calls:${Object.ReferenceEquals(callback, alias)}"
        }
`, "42:5:2:True", false}
            yield []object{"capture-free-backward-chain-keeps-direct-calls", "", `
        let before = GC.GetAllocatedBytesForCurrentThread()
        let first = func(n int32) int32 { return n + 1 }
        let second = func(n int32) int32 { return first(n) }
        let third = func(n int32) int32 { return second(n) }
        let result = third(41)
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        return "$result:$allocated"
`, "42:0", true}
            yield []object{"backward-overload-set", "", `
        let f = func() int32 { return 1 }
        let f = func(n int32) int32 { return n }
        let g = func() int32 { return f() + f(2) }
        let zero Func[int32] = f
        let one Func[int32, int32] = f
        return "${g()}:${zero()}:${one(2)}"
`, "3:1:2", true}
            yield []object{"nested-pointer-name-does-not-promote-capturing-local", "", `
        var calls = 0
        let first = func(n int32) int32 { return n + 1 }
        let callback = func(n int32) int32 {
            calls++
            return first(n)
        }
        let second = func(n int32) int32 { return callback(n) }
        let alias = callback
        var pointerResult = 0
        {
            let callback = func(n int32) int32 { return n + 10 }
            let after = func(n int32) int32 { return callback(n) }
            unsafe {
                let fp = &callback
                pointerResult = fp(41)
            }
        }
        return "$pointerResult:${second(1)}:${alias(2)}:$calls:${Object.ReferenceEquals(callback, alias)}"
`, "51:2:3:2:True", false}
            yield []object{"forward-group-with-capture-free-backward-dependency", "", `
        var seed = 99
        var calls = 99
        let helper = func(seed int32) int32 {
            var calls = seed
            calls++
            return calls
        }
        let first = func(n int32) int32 { return second(n) }
        let second = func(n int32) int32 { return helper(n) }
        let alias Func[int32, int32] = first
        return "${List[int32](){41}.Select(first).Single()}:${alias(0)}:$seed:$calls"
`, "42:1:99:99", true}
            yield []object{"forward-group-with-capture-free-recursive-dependency", "", `
        let helper = func(n int32) int32 {
            if n == 0 { return 1 }
            let next Func[int32, int32] = helper
            let recurse = func(value int32) int32 { return helper(value) }
            return next(n - 1) + recurse(0)
        }
        let first = func(n int32) int32 { return second(n) }
        let second = func(n int32) int32 { return helper(n) }
        let alias Func[int32, int32] = first
        return "${alias(41)}"
`, "42", true}
            yield []object{"forward-group-with-self-addressed-dependency", "", `
        let helper = func(n int32) int32 {
            if n == 0 { return 1 }
            unsafe {
                let fp = &helper
                return fp(n - 1) + 1
            }
        }
        let first = func(n int32) int32 { return second(n) }
        let second = func(n int32) int32 { return helper(n) }
        let alias Func[int32, int32] = first
        return "${alias(41)}"
`, "42", false}
            yield []object{"forward-group-with-capturing-recursive-dependency", "", `
        var calls = 0
        let helper = func(n int32) int32 {
            let self = helper
            if !Object.ReferenceEquals(self, helper) { return -1000 }
            calls++
            if n == 0 { return calls }
            let recurse = func(value int32) int32 { return helper(value) }
            return recurse(n - 1)
        }
        let first = func(n int32) int32 { return second(n) }
        let second = func(n int32) int32 { return helper(n) }
        let alias = helper
        let a = first(1)
        let b = alias(0)
        return "$a:$b:$calls:${Object.ReferenceEquals(helper, alias)}"
`, "2:3:3:True", true}
            yield []object{"async-recursive-capture-free-helper", `import System.Threading.Tasks`, `
        let helper = async func(n int32) int32 {
            if n == 0 { return 42 }
            return await helper(n - 1)
        }
        let next = async func(n int32) int32 { return await helper(n) }
        let callback Func[int32, Task[int32]] = next
        return "${helper(3).GetAwaiter().GetResult()}:${callback(2).GetAwaiter().GetResult()}"
`, "42:42", true}
            yield []object{"recursion-through-nested-generic-local", "", `
        let helper = func(n int32) int32 {
            if n == 0 { return 1 }
            let recurse[T] = func(value T, depth int32) int32 { return helper(depth) }
            return recurse(n, n - 1) + 1
        }
        let next = func(n int32) int32 { return helper(n) }
        return "${next(41)}"
`, "42", true}
            yield []object{"recursion-through-cyclic-nested-locals", "", `
        let helper = func(n int32) int32 {
            if n == 0 { return 1 }
            var visits = 0
            let first = func(depth int32) int32 {
                visits++
                return second(depth)
            }
            let second = func(depth int32) int32 {
                if depth == 0 { return helper(n - 1) }
                return first(depth - 1)
            }
            let result = first(1) + 1
            return if visits == 2 { result } else { -1000 }
        }
        let next = func(n int32) int32 { return helper(n) }
        return "${next(41)}"
`, "42", true}
            yield []object{"nested-conditional-capturing-shadows-outer-declared-function", `
func later(n int32) int32 { return n + 100 }
`, `
        let n = 41
        let helper = func(x int32) int32 { return x }
        let later = func(x int32) int32 { return helper(n + x + 1) }
        return later(0).ToString()
`, "42", true}
            yield []object{"nested-conditional-capture-free-avoids-delegate-allocation", "", `
        let first = func(n int32) int32 { return n + 1 }
        let callback = func(n int32) int32 {
            let helper = func(x int32) int32 { return x }
            let later = func(x int32) int32 { return helper(x + 1) }
            return first(later(n))
        }
        let later = func(n int32) int32 { return first(n) }
        let next = func(n int32) int32 { return callback(n) }
        let warm = next(40)
        let before = GC.GetAllocatedBytesForCurrentThread()
        let result = next(40)
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        return "$warm:$result:$allocated"
`, "42:42:0", true}
            yield []object{"nested-conditional-distinct-overload-preserves-outer-forward", "", `
        var calls = 0
        let callback = func(n int32) int32 {
            calls++
            let helper = func(x object) int32 { return 0 }
            let later = func(x object) int32 { return helper(x) + calls }
            return later(n) + later("hi")
        }
        let later = func(n int32) int32 { return n + 100 }
        return "${List[int32](){41}.Select(callback).Single()}:$calls"
`, "142:1", true}
            yield []object{"nested-conditional-capture-free-distinct-overload-prefers-outer-forward", "", `
        let callback = func(n int32) int32 {
            let helper = func(x object) int32 { return 0 }
            let later = func(x object) int32 { return helper(x) }
            return later(n)
        }
        let later = func(n int32) int32 { return n + 100 }
        return callback(41).ToString()
`, "141", true}
        }
    }
}
