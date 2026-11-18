package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import Xunit

open class Issue6082LocalFunctionValueTests {
    @Theory
    @MemberData("Cases")
    func OrdinaryClosures_RetainFunctionValues(
        name string,
        declarations string,
        body string,
        expected string,
        verifyIl bool
    ) {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue-6082", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let source = Path.Combine(directory, name + ".gs")
            let assembly = Path.Combine(directory, name + ".dll")
            File.WriteAllText(source, `package Issue6082
import System
import System.Collections.Generic
import System.Linq
` + declarations + `
shared class Probe {
    func Run() string {
` + body + `
    }
}`)
            Assert.Equal(
                0,
                Program.Main([]string{"/target:library", "/targetframework:net10.0", "/out:" + assembly, source})
            )
            // ILVerify does not implement calli. Function-pointer cases execute the emitted method instead.
            if verifyIl {
                IlVerifier.Verify(assembly)
            }
            let emitted = EmittedFixture.Load(assembly)
            Assert.Equal(expected, emitted.GetType("Issue6082.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        func Cases() sequence[[]object] {
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
        }
    }
}
