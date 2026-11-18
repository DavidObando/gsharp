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
    func OrdinaryClosures_RetainFunctionValues(name string, declarations string, body string, expected string) {
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
            IlVerifier.Verify(assembly)
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
`, "True:False:True"}
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
`, "True:True:False:True:4:9:True:True"}
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
`, "1:5:2:6"}
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
`, "1:5:2:6"}
        }
    }
}
