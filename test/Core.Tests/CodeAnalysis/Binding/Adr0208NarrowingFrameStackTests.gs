// <copyright file="Adr0208NarrowingFrameStackTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// ADR-0208 section 19, PR 2 slice 1: the frame stack threads a (cref:NarrowingState)
/// beside the frames. Every push, pop and frame write must update it, and
/// (cref:NarrowingFrameStack.AssertParity) compares it with a fresh projection.
open class Adr0208NarrowingFrameStackTests {
    @Fact
    func APushedFrame_IsProjectedInnermostFirst() {
        let x = Local("x")
        let stack = NarrowingFrameStack()
        stack.Push(Facts(x, TypeSymbol.Object))
        stack.Push(Facts(x, TypeSymbol.String))
        Assert.Equal(TypeSymbol.String, stack.State.NarrowedType(AccessPath.ForVariable(x)))
        stack.AssertParity()
        stack.RemoveAt(1)
        Assert.Equal(TypeSymbol.Object, stack.State.NarrowedType(AccessPath.ForVariable(x)))
        stack.AssertParity()
        stack.RemoveAt(0)
        Assert.Null(stack.State.NarrowedType(AccessPath.ForVariable(x)))
        stack.AssertParity()
    }

    @Fact
    func AWriteThroughAFrame_UpdatesTheStateOnEveryWritePath() {
        let x = Local("x")
        let y = Local("y")
        let stack = NarrowingFrameStack()
        let outer = stack.Push(Facts(x, TypeSymbol.Object))
        let inner = stack.Push(Dictionary[AccessPath, TypeSymbol]())
        inner.Add(AccessPath.ForVariable(y), TypeSymbol.String)
        stack.AssertParity()
        inner[AccessPath.ForVariable(x)] = TypeSymbol.String
        Assert.Equal(TypeSymbol.String, stack.State.NarrowedType(AccessPath.ForVariable(x)))
        stack.AssertParity()
        Assert.True(inner.Remove(AccessPath.ForVariable(x)))
        Assert.Equal(TypeSymbol.Object, stack.State.NarrowedType(AccessPath.ForVariable(x)))
        stack.AssertParity()
        outer.Clear()
        Assert.Null(stack.State.NarrowedType(AccessPath.ForVariable(x)))
        stack.AssertParity()
        inner.Clear()
        Assert.Equal(0, stack.State.Count)
        stack.AssertParity()
    }

    @Fact
    func AFrameThatIsOnTheStackTwice_KeepsItsOwnerUntilTheLastPop() {
        let x = Local("x")
        let stack = NarrowingFrameStack()
        let frame = stack.Push(Facts(x, TypeSymbol.String))
        stack.Add(frame)
        stack.RemoveAt(1)
        frame[AccessPath.ForVariable(x)] = TypeSymbol.Object
        Assert.Equal(TypeSymbol.Object, stack.State.NarrowedType(AccessPath.ForVariable(x)))
        stack.AssertParity()
        stack.RemoveAt(0)
        frame[AccessPath.ForVariable(x)] = TypeSymbol.String
        Assert.Null(stack.State.NarrowedType(AccessPath.ForVariable(x)))
        stack.AssertParity()
    }

    @Fact
    func ClearingTheStack_AndRestoringFrames_KeepsTheState() {
        let x = Local("x")
        let stack = NarrowingFrameStack()
        stack.Push(Facts(x, TypeSymbol.String))
        let saved = stack.ToList()
        stack.Clear()
        Assert.Equal(0, stack.State.Count)
        stack.AssertParity()
        stack.AddRange(saved)
        Assert.Equal(TypeSymbol.String, stack.State.NarrowedType(AccessPath.ForVariable(x)))
        stack.AssertParity()
    }

    @Fact
    func ARandomSequenceOfOperations_KeepsTheStateEqualToTheProjection() {
        let variables = []VariableSymbol{Local("a"), Local("b"), Local("c")}
        let types = []TypeSymbol{TypeSymbol.Object, TypeSymbol.String, TypeSymbol.Int32}
        let random = Random(5130)
        let stack = NarrowingFrameStack()
        for var step = 0; step < 4000; step++ {
            let path = AccessPath.ForVariable(variables[random.Next(variables.Length)])
            let type = types[random.Next(types.Length)]
            switch random.Next(7) {
                case 0 {
                    stack.Push(Dictionary[AccessPath, TypeSymbol]())
                }
                case 1 {
                    if stack.Count > 0 {
                        stack.RemoveAt(random.Next(stack.Count))
                    }
                }
                case 2 {
                    if stack.Count > 0 && !stack[stack.Count - 1].ContainsKey(path) {
                        stack[stack.Count - 1].Add(path, type)
                    }
                }
                case 3 {
                    if stack.Count > 0 {
                        stack[random.Next(stack.Count)][path] = type
                    }
                }
                case 4 {
                    if stack.Count > 0 {
                        stack[random.Next(stack.Count)].Remove(path)
                    }
                }
                case 5 {
                    if stack.Count > 0 {
                        stack[random.Next(stack.Count)].Clear()
                    }
                }
                default {
                    if stack.Count > 0 && random.Next(10) == 0 {
                        stack.Add(stack[random.Next(stack.Count)])
                    }
                }
            }
            stack.AssertParity()
        }
    }

    @Fact
    func AWriteThatBypassesTheFrame_IsCaughtByTheAssertion() {
        // The wrapped dictionary is shared. A write to it directly is invisible to
        // the stack, and the assertion reports it.
        let x = Local("x")
        let raw = Dictionary[AccessPath, TypeSymbol]()
        let stack = NarrowingFrameStack()
        stack.Push(raw)
        raw[AccessPath.ForVariable(x)] = TypeSymbol.String
        Assert.Throws[InvalidOperationException](() -> stack.AssertParity())
    }

    @Fact
    func AQueryChecksEveryPath_NotOnlyTheQueriedOne() {
        // The bypass is on `y`. The query asks for `x`, whose answer is right.
        let x = Local("x")
        let y = Local("y")
        let raw = Dictionary[AccessPath, TypeSymbol]()
        let stack = NarrowingFrameStack()
        let frame = stack.Push(raw)
        frame[AccessPath.ForVariable(x)] = TypeSymbol.String
        raw[AccessPath.ForVariable(y)] = TypeSymbol.String
        Assert.Throws[InvalidOperationException](
            () -> NarrowingParity.Check(stack, AccessPath.ForVariable(x), TypeSymbol.String)
        )
    }

    @Fact
    func TheOneFrameWalk_AssertsParityOnEveryQuery() {
        let x = Local("x")
        let raw = Dictionary[AccessPath, TypeSymbol]()
        let stack = NarrowingFrameStack()
        stack.Push(raw)
        raw[AccessPath.ForVariable(x)] = TypeSymbol.String
        NarrowingParity.Begin()
        try {
            Assert.Throws[InvalidOperationException](() -> stack.Query(AccessPath.ForVariable(x)))
        } finally {
            NarrowingParity.End()
        }
    }

    @Fact
    func NoBinderCodeWalksTheFramesOutsideTheOneFrameWalk() {
        // Every narrowed-type lookup goes through NarrowingFrameStack.Query, so the
        // parity assertion sees it (a direct walk skipped it once, in the call resolver).
        let offenders = List[string]()
        for path in TestSource.SourceFiles(SearchOption.AllDirectories, "src/Core/CodeAnalysis/Binding") {
            if Path.GetFileNameWithoutExtension(path).StartsWith("NarrowingFrame", StringComparison.Ordinal) {
                continue
            }
            let text = File.ReadAllText(path)
            if Regex.IsMatch(text, `NarrowedVariables\[[^\]]+\]\s*\.\s*TryGetValue\(`) {
                offenders.Add(Path.GetFileName(path))
            }
        }
        Assert.True(
            offenders.Count == 0,
            "Walk the frames with NarrowedVariables.Query: " + string.Join(", ", offenders)
        )
    }

    @Fact
    func TheAssertionHoldsWhileBindingProgramsWithEveryNarrowingShape() {
        NarrowingParity.Begin()
        try {
            for source in Programs() {
                let result = EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
                Assert.False(result.Diagnostics.Any((d Diagnostic) -> d.Id == "GS9998"))
            }
        } finally {
            NarrowingParity.End()
        }
    }

    shared {
        private func Local(name string) VariableSymbol -> LocalVariableSymbol(
            name,
            false,
            NullableTypeSymbol.Get(TypeSymbol.Object)
        )

        private func Facts(variable VariableSymbol, type TypeSymbol) Dictionary[AccessPath, TypeSymbol] {
            let facts = Dictionary[AccessPath, TypeSymbol]()
            facts[AccessPath.ForVariable(variable)] = type
            return facts
        }

        private func Programs() sequence[string] {
            yield `package T
func Get() string? { return nil }
func A(c bool, k int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    if c { s = nil; return 1 } else { Console.WriteLine(s.Length) }
    switch k {
        case 1 { s = "a" }
        default { return 2 }
    }
    return s.Length
}`
            yield `package T
open class Animal { var Name string = "" }
class Dog : Animal { func Bark() string { return "woof" } }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}
func B(b Box, x Animal?, y object) string {
    if b.Pet == nil { return "" }
    if x is Dog { return x.Bark() }
    if y is string { return y }
    return b.Pet.Name
}`
            yield `package T
func Get() string? { return nil }
func C(n int32, c bool) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        if c { break }
        total = total + s.Length
        s = Get()
    }
    let f = func() int32 { return n }
    try {
        total = total + f()
    } catch {
        s = nil
    } finally {
        total = total + 1
    }
    return total
}`
            yield `package T
func Get() string? { return "a" }
func D(c bool) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    if c { goto done }
    Console.WriteLine("x")
    done:
    return s.Length
}`
            yield `package T
func F(s string?, t object?) int32 {
    let n = if let a = s { a.Length } else { 0 }
    if let b = t, b is string { return n }
    if let c = s, c.Length > 0 { return c.Length }
    return n
}`
            yield `package T
func Get() string? { return "a" }
func Update(ref s string?) bool {
    s = Get()
    return true
}
func E(a string?, b string?) int32 {
    guard let x = a else { return 0 }
    if let y = b, y.Length > 0 { return x.Length + y.Length }
    var t string? = Get()
    if t != nil && Update(ref t) { return t.Length }
    return (a ?? "").Length
}`
        }
    }
}
