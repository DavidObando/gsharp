// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import Xunit

class Issue6105CapturingRecursiveDelegateTests {
    @Fact
    func OverloadSelection_DoesNotNarrowPersistentFunctionSignature() {
        const source = `func Run() string {
    var outer = 41
    let first = func(value object, n int32) string {
        return n == 0 ? "${value}:${outer}" : second(value, n - 1)
    }
    let first = func(value object) string { return first(value, 0) }
    let second = func(value object, n int32) string { return first(value, n) }
    let narrow (string, int32) -> object = first
    let broad (object, int32) -> string = first
    outer = 50
    return "${narrow("a", 1)},${broad(7, 1)},${System.Object.ReferenceEquals(narrow, broad)}"
}
System.Console.Write(Run())`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "a:50,7:50,True", "6105")
    }

    @Fact
    func BlockExpressions_InitializeEscapingRecursiveDelegateCells() {
        const source = `func Make(seed int32) (int32) -> int32 {
    let callback (int32) -> int32 = {
        var outer = seed
        let first = func(n int32) int32 {
            if n == 0 {
                outer++
                return outer
            }
            return second(n - 1)
        }
        let second = func(n int32) int32 { return first(n) }
        outer++
        first
    }
    return callback
}
let left = Make(10)
let right = Make(100)
System.GC.Collect()
System.Console.Write("${left(1)},${right(2)},${left(0)}")`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "12,102,13", "6105")
    }

    @Fact
    func OverloadedCapturingMembers_PreserveSelectedSignaturesAndIdentity() {
        const source = `delegate Step(n int32) int32;
func Run() string {
    var outer = 41
    let first = func(n int32) int32 {
        return n == 0 ? outer : second(n - 1)
    }
    let first = func(n int32, amount int32) int32 {
        outer += amount
        return second(n)
    }
    let second = func(n int32) int32 { return first(n) }
    let a (int32) -> int32 = first
    let alias (int32) -> int32 = first
    let b (int32, int32) -> int32 = first
    var handlers Step? = nil
    handlers += first
    handlers -= first
    outer = 50
    let x = a(1)
    let y = b(1, 2)
    return "${x},${y},${second(1)},${System.Object.ReferenceEquals(a, alias)},${handlers == nil}"
}
System.Console.Write(Run())`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "50,52,52,True,True", "6105")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ByReferenceParameters_KeepNamedAndInferredDelegateContractsAndSharedState(infer bool) {
        const source = `delegate Step(ref value int32, out observed int32, in increment int32, n int32) int32;
func Run() string {
    var outer = 41
    let first = func(ref value int32, out observed int32, in increment int32, n int32) int32 {
        if n == 0 {
            value += increment
            outer++
            observed = outer
            return value + observed
        }
        return second(ref value, out observed, in increment, n - 1)
    }
    let second = func(ref value int32, out observed int32, in increment int32, n int32) int32 {
        return first(ref value, out observed, in increment, n)
    }
    let callback Step = first
    let inferred Step = first
    var handlers Step? = nil
    handlers += first
    handlers -= first
    outer = 50
    var value = 1
    var observed = 0
    let increment = 2
    let a = callback(ref value, out observed, in increment, 1)
    let b = inferred(ref value, out observed, in increment, 1)
    let c = first(ref value, out observed, in increment, 1)
    return "${a},${b},${c};${value},${observed},${handlers == nil}"
}
System.Console.Write(Run())`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            if infer {
                source.Replace("let inferred Step = first", "let inferred = first")
            } else {
                source
            },
            "54,57,60;7,53,True",
            "6105"
        )
    }

    @Fact
    func ConstructorInitializers_InitializeEscapingRecursiveFunctionValues() {
        const source = `open class Base {
    let callback (int32) -> int32
    init(value (int32) -> int32) { callback = value }
    func Read(n int32) int32 -> callback(n)
}
class Derived : Base {
    init(seed int32) : base((() -> {
        var outer = seed
        let first = func(n int32) int32 {
            if n == 0 {
                outer++
                return outer
            }
            return second(n - 1)
        }
        let second = func(n int32) int32 { return first(n) }
        let callback (int32) -> int32 = first
        outer++
        return callback
    })()) {}
}
class Primary(seed int32) : Base((() -> {
    var outer = seed
    let first = func(n int32) int32 {
        if n == 0 {
            outer++
            return outer
        }
        return second(n - 1)
    }
    let second = func(n int32) int32 { return first(n) }
    let callback (int32) -> int32 = first
    outer++
    return callback
})()) {}
let left = Derived(10)
let right = Primary(100)
System.GC.Collect()
System.Console.Write("${left.Read(1)},${right.Read(2)},${left.Read(0)},${right.Read(0)}")`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "12,102,13,103", "6105")
    }

    @Fact
    func RecursiveBodies_ConvertForwardAndBackwardMembersThroughSharedDelegateCells() {
        const source = `delegate Step(n int32) int32;
func Make(seed int32) (int32) -> int32 {
    var outer = seed
    let first = func(n int32) int32 {
        if n == 0 {
            outer++
            return outer
        }
        let next Step = second
        return next(n - 1)
    }
    let second = func(n int32) int32 {
        let previous Step = first
        return previous(n)
    }
    return first
}
let a = Make(10)
let b = Make(100)
System.Console.Write("${a(2)},${b(3)},${a(1)}")`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "11,101,12", "6105")
    }

    @Fact
    func FunctionValues_PreserveIdentityAndDelegateRemovalAcrossNestedScopes() {
        const source = `delegate Step(n int32) int32;
func Run() string {
    var outer = 41
    let first = func(n int32) int32 {
        return n == 0 ? outer : second(n - 1)
    }
    let second = func(n int32) int32 { return first(n) }
    let original = first
    let alias = first
    let get = () -> {
        let callback Step = first
        return callback
    }
    var natural ((int32) -> int32)? = nil
    natural += first
    natural -= first
    var named Step? = nil
    named += get()
    named -= first
    outer++
    return "${System.Object.ReferenceEquals(original, alias)},${natural == nil},${named == nil},${original(1)}"
}
System.Console.Write(Run())`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "True,True,True,42", "6105")
    }

    @Fact
    func ReportedForwardRecursiveCapture_ConvertsToFunctionValue() {
        const source = `func Run() int32 {
    var outer = 41
    let first = func(x int32) int32 {
        if x == 0 { return outer }
        return second(x - 1)
    }
    let second = func(x int32) int32 { return first(x) }
    let callback (int32) -> int32 = first
    return callback(1)
}
System.Console.Write(Run())`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "41", "6105")
    }

    @Fact
    func DirectAndConvertedCalls_ShareCellsAndEvaluateInitializersAndArgumentsOnce() {
        const source = `import System
delegate Step(n int32) int32;
class Trace {
    shared {
        var Initializers int32
        var Arguments int32
    }
}
func Seed() int32 {
    Trace.Initializers++
    return 10
}
func Next() int32 {
    Trace.Arguments++
    return 1
}
func Apply(callback (int32) -> int32, n int32) int32 -> callback(n)
func Run() string {
    var outer = Seed()
    var calls = 0
    let first = func(x int32) int32 {
        calls++
        if x == 0 { return outer }
        outer++
        return second(x - 1)
    }
    let second = func(x int32) int32 {
        calls += 10
        outer += 10
        return first(x)
    }
    let inferred = first
    let natural (int32) -> int32 = first
    let named Step = second
    let imported Func[int32, int32] = first
    let read = () -> outer
    outer = 30
    let a = first(1)
    let b = natural(Next())
    let c = named(0)
    outer = 70
    let d = inferred(0)
    let e = Apply(first, Next())
    let f = imported(0)
    return "${a},${b},${c},${d},${e},${f};${read()},${calls};${Trace.Initializers},${Trace.Arguments}"
}
Console.Write(Run())`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "41,52,62,70,81,81;81,49;1,2",
            "6105"
        )
    }

    @Fact
    func EscapedFactory_CapturesThroughMethodGroupAndPreservesInvocationBoundaries() {
        const source = `delegate Step(n int32) int32;
delegate Factory() Step;
func Make(seed int32) Factory {
    var outer = seed
    let first = func(n int32) int32 {
        if n == 0 {
            outer++
            return outer
        }
        return second(n - 1)
    }
    let second = func(n int32) int32 { return first(n) }
    return () -> {
        let callback Step = first
        return callback
    }
}
let left = Make(10)
let right = Make(100)
System.GC.Collect()
let a = left()
let b = right()
let c = left()
System.Console.Write("${a(1)},${b(1)},${c(2)},${a(0)},${b(0)}")`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "11,101,12,13,102", "6105")
    }

    @Fact
    func EscapedLoopCaptures_ShareWithinIterationButNotAcrossIterations() {
        const source = `import System.Collections.Generic
delegate Step(n int32) int32;
var callbacks = List[Step]()
for var i = 0; i < 3; i++ {
    var outer = i * 10
    let first = func(n int32) int32 {
        if n == 0 {
            outer++
            return outer
        }
        return second(n - 1)
    }
    let second = func(n int32) int32 { return first(n) }
    callbacks.Add(first)
    outer++
    System.Console.Write("${first(0)},")
}
System.Console.Write("|")
for callback in callbacks {
    System.Console.Write("${callback(1)},")
}
System.Console.Write("|${callbacks[0](0)}")`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "2,12,22,|3,13,23,|4", "6105")
    }

    @Fact
    func GenericLexicalOwnerAndSymbolicDelegateTargets_KeepCapture() {
        const source = `delegate Step[T](n int32) T;
class Payload {
    var Value int32
}
class Box[T] {
    func Make(seed int32) Step[Payload] {
        var value = Payload{Value: seed}
        let first = func(n int32) Payload {
            if n == 0 {
                value.Value += 3
                return value
            }
            return second(n - 1)
        }
        let second = func(n int32) Payload { return first(n) }
        let natural (int32) -> Payload = first
        let named Step[Payload] = second
        value = Payload{Value: seed + 1}
        System.Console.Write("${natural(1).Value},")
        return named
    }
}
let callback = Box[string]().Make(10)
System.Console.Write("${callback(1).Value},${callback(0).Value}")`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "14,17,20", "6105")
    }
}
