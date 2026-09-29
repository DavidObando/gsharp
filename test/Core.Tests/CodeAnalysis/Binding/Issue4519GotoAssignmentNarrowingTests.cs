// <copyright file="Issue4519GotoAssignmentNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4519: a forward <c>goto</c> must not inherit assignment narrowing
/// performed only on the skipped fallthrough path.
/// </summary>
public class Issue4519GotoAssignmentNarrowingTests
{
    [Fact]
    public void ForwardGoto_BypassesAssignment_ReportsNullableReceiver()
    {
        var result = Evaluate("""
            func Run(cond bool) string {
                var x string? = nil
                if cond {
                    goto SkipAssign
                }
                x = "hello"
            SkipAssign:
                return x.Length.ToString()
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void DirectFallthroughAssignment_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run() {
                var x string? = nil
                x = "hello"
                Console.WriteLine(x.Length)
            }

            Run()
            """, "5");
    }

    [Fact]
    public void BackwardGoto_AfterDominatingAssignment_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run() {
                var x string? = nil
                x = "ok"
                var count = 0
            Again:
                Console.WriteLine(x.Length)
                count++
                if count < 2 {
                    goto Again
                }
            }

            Run()
            """, "2", "2");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsNullableReceiver()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsNullableMethodReceiver()
    {
        var result = Evaluate("""
            func Run() string {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let value = x.ToString()
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return value
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("ToString", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsNonNullConversion()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let y string = x
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return y.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsIndexReceiver()
    {
        var result = Evaluate("""
            func Run() char {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let first = x[0]
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return first
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0116");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsIndirectInvocation()
    {
        var result = Evaluate("""
            import System

            func Run() int32 {
                var f Func[int32]? = nil
                f = () -> 1
                var count = 0
            Again:
                let value = f()
                if count == 0 {
                    count++
                    f = nil
                    goto Again
                }
                return value
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("f", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsParenthesizedIndirectInvocation()
    {
        var result = Evaluate("""
            import System

            func Run() int32 {
                var f Func[int32]? = nil
                f = () -> 1
                var count = 0
            Again:
                let value = (f)()
                if count == 0 {
                    count++
                    f = nil
                    goto Again
                }
                return value
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("(f)", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsMemberWriteReceiver()
    {
        var result = Evaluate("""
            import System.Text

            func Run() int32 {
                var x StringBuilder? = nil
                x = StringBuilder()
                var count = 0
            Again:
                x.Length = 0
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return count
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsParenthesizedMemberWriteReceiver()
    {
        var result = Evaluate("""
            import System.Text

            func Run() int32 {
                var x StringBuilder? = nil
                x = StringBuilder()
                var count = 0
            Again:
                (x).Length = 0
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return count
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsLockSubject()
    {
        var result = Evaluate("""
            class Gate {
            }

            func Run() int32 {
                var x Gate? = nil
                x = Gate{}
                var count = 0
            Again:
                lock x {
                    count++
                }
                if count == 1 {
                    x = nil
                    goto Again
                }
                return count
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsDeconstructionSource()
    {
        var result = Evaluate("""
            data class Pair(A int32, B int32) {
            }

            func Run() int32 {
                var x Pair? = nil
                x = Pair(1, 2)
                var count = 0
            Again:
                let (a, b) = x
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return a + b
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterTypeTestNarrowing_ReportsMemberAccess()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                func Bark() string { return "woof" }
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    let sound = x.Bark()
                    x = Cat{}
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("Bark", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_IncompatibleTypeTestNarrowing_ReportsMemberAccess()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                func Bark() string { return "woof" }
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    let sound = x.Bark()
                    x = Cat{}
                    if x is Cat { goto Again }
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("Bark", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InheritedMemberDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
                func Name() string { return "animal" }
            }
            class Dog : Animal {
            }
            class Cat : Animal {
            }

            func Run() int32 {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let name = x.Name()
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return name.Length
                }
                return 0
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void BackwardGoto_ParenthesizedOverrideDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
                open func Name() string { return "animal" }
            }
            class Dog : Animal {
                override func Name() string { return "dog" }
            }
            class Cat : Animal {
                override func Name() string { return "cat" }
            }

            func Run() int32 {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let name = (x).Name()
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return name.Length
                }
                return 0
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void BackwardGoto_InterfaceMemberDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            interface Named {
                func Name() string;
            }
            class Dog : Named {
                func Name() string { return "dog" }
            }
            class Cat : Named {
                func Name() string { return "cat" }
            }

            func Run() int32 {
                var x Named = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let name = x.Name()
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return name.Length
                }
                return 0
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void BackwardGoto_SubtypeOnlyOverloadStillRequiresNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
                func Describe(value int32) string { return value.ToString() }
            }
            class Dog : Animal {
                func Describe(value string) string { return value }
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    let description = x.Describe("dog")
                    x = Cat{}
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("Describe", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InheritedIndexerDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
                prop this[index int32] int32 -> index + 1
            }
            class Dog : Animal {
            }
            class Cat : Animal {
            }

            func Run() int32 {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let value = (x)[0]
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return value
                }
                return 0
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void BackwardGoto_InterfaceIndexerDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            interface Values {
                prop this[index int32] int32 { get; }
            }
            class Dog : Values {
                prop this[index int32] int32 -> 1
            }
            class Cat : Values {
                prop this[index int32] int32 -> 2
            }

            func Run() int32 {
                var x Values = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let value = x[0]
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return value
                }
                return 0
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void BackwardGoto_SubtypeOnlyIndexerOverloadStillRequiresNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
                prop this[index int32] string -> index.ToString()
            }
            class Dog : Animal {
                prop this[index string] string -> index
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    let value = x["dog"]
                    x = Cat{}
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0116");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_ExistingEdgeReceivesLaterMemberAccess()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = "safe"
                var first = true
            Again:
                if first {
                    first = false
                    x = nil
                    goto Again
                }
                return x.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_TypeTestNarrowingAtForSource_ReportsConversion()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x object = "safe"
                if x is string {
                Again: {
                        for ch in x {
                        }
                        x = 42
                        goto Again
                    }
                }
                return 0
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_TypeTestNarrowingThroughUpcast_ReportsConversion()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
            }
            class Cat : Animal {
            }

            func Run() object {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    let result object = x
                    x = Cat{}
                    goto Again
                }
                return x
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_TypeTestNarrowingThroughNullableUpcast_ReportsConversion()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
            }
            class Cat : Animal {
            }

            func Run() object? {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    let result object? = x
                    x = Cat{}
                    goto Again
                }
                return x
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_TypeTestNarrowingThroughNullSafeCall_ReportsConversion()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                func Bark() string { return "woof" }
            }
            class Cat : Animal {
            }

            func Run() string? {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    let result = x?.Bark()
                    x = Cat{}
                    goto Again
                }
                return nil
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_StackedLabeledGuardReestablishesNarrowing()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = "safe"
                var count = 0
            First:
            Second:
                if x == nil {
                    return 0
                }
                let length = x.Length
                if count == 0 {
                    count++
                    x = nil
                    goto First
                }
                return length
            }

            Console.WriteLine(Run())
            """, "0");
    }

    [Fact]
    public void BackwardGoto_PoppedNestedGuardGenerationDoesNotHideOuterProof()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                var first = true
            Again:
                if first {
                    first = false
                Guard:
                    if x == nil {
                        return 0
                    }
                }
                let length = x.Length
                x = nil
                goto Again
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InvalidatesNarrowedMemberPath()
    {
        var result = Evaluate("""
            data class Box(Value string?) {
            }

            func Run() int32 {
                var box = Box("safe")
                if box.Value != nil {
                Again:
                    let length = box.Value.Length
                    box = Box(nil)
                    goto Again
                }
                return 0
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InvalidatesNarrowedMemberPathAtLockBoundary()
    {
        var result = Evaluate("""
            class Gate {
            }
            data class Box(Gate Gate?) {
            }

            func Run() int32 {
                var box = Box(Gate{})
                if box.Gate != nil {
                Again:
                    lock box.Gate {
                    }
                    box = Box(nil)
                    goto Again
                }
                return 0
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("box.Gate", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InvalidatesNarrowedMemberPathConversion()
    {
        var result = Evaluate("""
            data class Box(Value string?) {
            }

            func Run() string {
                var box = Box("safe")
                if box.Value != nil {
                Again:
                    let value string = box.Value
                    box = Box(nil)
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("box.Value", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.Contains("'string?'", diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("'Box'", diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InvalidatesNarrowedMemberPathIndex()
    {
        var result = Evaluate("""
            data class Box(Text string?) {
            }

            func Run() char {
                var box = Box("safe")
                if box.Text != nil {
                Again:
                    let first = box.Text[0]
                    box = Box(nil)
                    goto Again
                }
                return 'x'
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0116");
        Assert.Equal("Text", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.Contains("'string?'", diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("'Box'", diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InvalidatesNarrowedMemberPathWriteReceiver()
    {
        var result = Evaluate("""
            class Child {
                var Name string = ""
            }
            data class Box(Child Child?) {
            }

            func Run() int32 {
                var box = Box(Child{})
                if box.Child != nil {
                Again:
                    box.Child.Name = "safe"
                    box = Box(nil)
                    goto Again
                }
                return 0
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Name", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_IncompatibleSubtypeDoesNotPreserveTargetNarrowing()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                func Bark() string { return "woof" }
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Cat{}
                if x is Cat {
                    goto Use
                }
            Guard:
                if x !is Dog {
                    return ""
                }
            Use:
                return x.Bark()
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("Bark()", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_BypassesConditionFrame_ReportsMemberAccess()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                goto Use
                if x != nil {
                Use:
                    return x.Length
                }
                return 0
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyEstablishesOnlyReachableNarrowing()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                try {
                    goto Done
                }
                finally {
                    x = "safe"
                }
            Done:
                return x.Length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void ForwardGoto_FinallyNarrowingDoesNotOverrideReachableFallthrough()
    {
        var result = Evaluate("""
            func Run(jump bool) int32 {
                var x string? = nil
                if jump {
                    try {
                        goto Done
                    }
                    finally {
                        x = "safe"
                    }
                }
            Done:
                return x.Length
            }

            Run(false)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyNarrowingIsInvalidatedByUnsafeBackedge()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                try {
                    goto Again
                }
                finally {
                    x = "safe"
                }
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyIgnoresUninvokedFunctionBodyMutation()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                try {
                    goto Done
                }
                finally {
                    let mutate = func() { x = nil }
                }
            Done:
                return x.Length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void ForwardGoto_FinallyIncludesImmediatelyInvokedFunctionBodyMutation()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                try {
                    goto Done
                }
                finally {
                    (func() { x = nil })()
                }
            Done:
                return x.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyIncludesInvokedStoredFunctionBodyMutation()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                try {
                    goto Done
                }
                finally {
                    let mutate = func() { x = nil }
                    mutate()
                }
            Done:
                return x.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyIncludesInvokedCallableAliasMutation()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                try {
                    goto Done
                }
                finally {
                    let mutate = func() { x = nil }
                    let alias (() -> void) = mutate
                    var assigned (() -> void) = func() { }
                    assigned = alias
                    assigned()
                }
            Done:
                return x.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyIncludesAliasDeclaredOutsideFinally()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                let mutate = func() { x = nil }
                try {
                    goto Done
                }
                finally {
                    let alias (() -> void) = mutate
                    alias()
                }
            Done:
                return x.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyIncludesConditionalCallableTarget()
    {
        var result = Evaluate("""
            func Run(useNoop bool) int32 {
                var x string? = nil
                x = "safe"
                try {
                    goto Done
                }
                finally {
                    let mutate = func() { x = nil }
                    let noop = func() { }
                    var action (() -> void) = mutate
                    if useNoop {
                        action = noop
                    }
                    action()
                }
            Done:
                return x.Length
            }

            Run(false)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyUsesLastUnconditionalCallableTarget()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                try {
                    goto Done
                }
                finally {
                    let mutate = func() { x = nil }
                    let noop = func() { }
                    var action (() -> void) = mutate
                    action = noop
                    action()
                }
            Done:
                return x.Length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void ForwardGoto_LeavingDeferScopeAppliesCleanupMutation()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                let mutate = func() { x = nil }
                {
                    defer mutate()
                    goto Done
                }
            Done:
                return x.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyIncludesWritableRefMutation()
    {
        var result = Evaluate("""
            func Clear(out value string?) {
                value = nil
            }

            func Run() int32 {
                var x string? = nil
                x = "safe"
                try {
                    goto Done
                }
                finally {
                    Clear(&x)
                }
            Done:
                return x.Length
            }

            Run()
            """);

        var diagnostic = result.Diagnostics.Single(d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyReadonlyRefPreservesUnrelatedNarrowing()
    {
        AssertRuns("""
            import System

            func Observe(in value string) {
            }

            func Run() int32 {
                var x string? = nil
                x = "safe"
                var observed = "read"
                try {
                    goto Done
                }
                finally {
                    Observe(&observed)
                }
            Done:
                return x.Length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void BackwardGoto_FinallyIncludesMemberPathMutation()
    {
        var result = Evaluate("""
            class Box {
                var Value string?

                init(value string?) {
                    Value = value
                }
            }

            func Clear(box Box) {
                box.Value = nil
            }

            func Run() int32 {
                let box = Box("safe")
                if box.Value != nil {
                Again:
                    let length = box.Value.Length
                    try {
                        if box.Value != nil {
                            goto Again
                        }
                    }
                    finally {
                        Clear(box)
                    }
                    return length
                }
                return 0
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_ConstrainedCallArgumentTracksNarrowing()
    {
        var result = Evaluate("""
            import System

            func Run[T IConvertible](convertible T) object? {
                var x Type? = nil
                x = "".GetType()
                var count = 0
            Again:
                let converted = convertible.ToType(x, nil)
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return converted
            }

            Run(1)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_IntoNestedScopePreservesOuterNarrowingFrame()
    {
        AssertRuns("""
            import System

            func Run() {
                var outer string? = nil
                outer = "safe"
                {
                    goto Use
                Use:
                    Console.WriteLine(outer.Length)
                }
                Console.WriteLine(outer.Length)
            }

            Run()
            """, "4", "4");
    }

    [Fact]
    public void UnreachableForwardGoto_DoesNotInvalidateReachableNarrowing()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                goto Done
                x = nil
                goto Done
            Done:
                return x.Length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void UnreachableBackwardGoto_DoesNotInvalidateReachableNarrowing()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
            Again:
                let length = x.Length
                return length
                x = nil
                goto Again
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void ForwardGoto_EnteringNestedBlockPropagatesReachability()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                goto Enter
                {
                Enter:
                    var marker = 0
                }
                goto Done
                x = "safe"
            Done:
                return x.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_EnteringLoopBodyPropagatesReachability()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                var keepGoing = true
                goto Enter
                for keepGoing {
                Enter:
                    keepGoing = false
                }
                goto Done
                x = "safe"
            Done:
                return x.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InvalidatesNarrowedCallableMemberPath()
    {
        var result = Evaluate("""
            data class Holder(Callback (() -> int32)?) {
            }

            func One() int32 { return 1 }

            func Run() int32 {
                var holder = Holder(One)
                if holder.Callback != nil {
                Again:
                    let value = holder.Callback.Invoke()
                    holder = Holder(nil)
                    goto Again
                }
                return 0
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("Invoke", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_MemberNotNullAfterLabelReestablishesNarrowing()
    {
        AssertRuns("""
            import System
            import System.Diagnostics.CodeAnalysis

            class Box {
                var _name string?

                func EnsureInit() {
                    _name = "safe"
                }

                @MemberNotNull(members: []string{"_name"})
                func EnsureInitAnnotated() {
                    _name = "safe"
                }

                func Run() int32 {
                    _name = "seed"
                    var count = 0
                Again:
                    this.EnsureInitAnnotated()
                    let length = _name.Length
                    if count == 0 {
                        count++
                        _name = nil
                        goto Again
                    }
                    return length
                }
            }

            Console.WriteLine(Box{}.Run())
            """, "4");
    }

    [Fact]
    public void UnrelatedEarlierGotoDoesNotLinkLaterBackwardLabel()
    {
        AssertRuns("""
            import System

            func Run(skip bool) int32 {
                var x string? = nil
                x = "safe"
                if skip {
                    goto Use
                }
                var first = true
            Again:
                if first {
                    first = false
                    x = nil
                    goto Again
                }
                x = "safe"
            Use:
                return x.Length
            }

            Console.WriteLine(Run(true))
            Console.WriteLine(Run(false))
            """, "4", "4");
    }

    [Fact]
    public void ForwardGoto_BypassesLabeledSwitchGuard_ReportsMemberAccess()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                func Bark() string { return "woof" }
            }
            class Cat : Animal {
            }

            func Run() string {
                var a Animal = Cat{}
                goto Use
            Guard:
                switch a {
                    case d is Dog {
                    }
                    default {
                        return ""
                    }
                }
            Use:
                return a.Bark()
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("Bark()", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InvalidationPropagatesThroughForwardLabel()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                if count == 0 {
                    count++
                    goto Use
                }
                x = "safe"
            Use:
                let length = x.Length
                if count == 1 {
                    count++
                    x = nil
                    goto Again
                }
                return length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_LateForwardLabelDependencyUpdatesExistingEdge()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = "safe"
                var retry = true
            Again:
                goto Use
            Back:
                if retry {
                    retry = false
                    x = nil
                    goto Again
                }
                x = "safe"
            Use:
                let length = x.Length
                goto Back
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_RepeatedGuardReestablishesNarrowing()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = "safe"
                var count = 0
            Again:
                if x != nil {
                    Console.WriteLine(x.Length)
                }
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return count
            }

            Console.WriteLine(Run())
            """, "4", "1");
    }

    [Fact]
    public void BackwardGoto_EarlyExitGuardReestablishesNarrowing()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                if x == nil { return count }
                let length = x.Length
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return length
            }

            Console.WriteLine(Run())
            """, "1");
    }

    [Fact]
    public void BackwardGoto_AfterPostLabelNonNullAssignment_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again: {
                    x = "safe"
                    let length = x.Length
                    if count == 0 {
                        count++
                        x = nil
                        goto Again
                    }
                    return length
                }
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void BackwardGoto_PostLabelAssignmentWithoutTargetGeneration_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = "safe"
                var count = 0
            Again:
                x = "safe"
                let length = x.Length
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void BackwardGoto_ThroughFinallyMutation_ReportsNullableReceiver()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    try {
                        goto Again
                    } finally {
                        x = nil
                    }
                }
                return length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_ThroughNonNullFinallyAssignment_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    try {
                        x = nil
                        goto Again
                    } finally {
                        x = "safe"
                    }
                }
                return length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void BackwardGoto_ThroughNonCompletingFinally_DoesNotInvalidate()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    try {
                        goto Again
                    } finally {
                        return 0
                    }
                }
                return length
            }

            Console.WriteLine(Run())
            """, "0");
    }

    [Fact]
    public void NestedFunction_BackwardGotoUsesIndependentJoinState()
    {
        var result = Evaluate("""
            func Outer() int32 {
                var inner = func() int32 {
                    var x string? = nil
                    x = "safe"
                    var count = 0
                Again:
                    let length = x.Length
                    if count == 0 {
                        count++
                        x = nil
                        goto Again
                    }
                    return length
                }
                return inner()
            }

            Outer()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void MultipleForwardBranches_BypassingDifferentAssignments_RejectBothReads()
    {
        const string source = """
            func Run(first bool, second bool) int32 {
                var x string? = nil
                var y string? = nil
                if first { goto AfterX }
                x = "x"
            AfterX:
                if second { goto AfterY }
                y = "yy"
            AfterY:
                return x.Length + y.Length
            }

            Run(true, true)
            """;
        var result = Evaluate(source);

        var nullableReads = result.Diagnostics.Where(d => d.Id == "GS0158").ToArray();
        Assert.Equal(2, nullableReads.Length);
        Assert.All(nullableReads, d => Assert.Equal("Length", d.Location.Text.ToString(d.Location.Span)));
        Assert.Equal(
            new[]
            {
                source.IndexOf("x.Length", StringComparison.Ordinal) + "x.".Length,
                source.IndexOf("y.Length", StringComparison.Ordinal) + "y.".Length,
            },
            nullableReads.Select(d => d.Location.Span.Start).OrderBy(position => position));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void MultipleGotosToSameLabel_IntersectTheirNarrowingStates()
    {
        var result = Evaluate("""
            func Run(first bool, second bool) int32 {
                var x string? = nil
                if first { goto Done }
                x = "safe"
                if second { goto Done }
            Done:
                return x.Length
            }

            Run(true, false)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void AssignmentBeforeEveryForwardJump_RemainsNarrowedAtLabel()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var x string? = nil
                x = "safe"
                if jump { goto Done }
                x = "also safe"
            Done:
                Console.WriteLine(x.Length)
            }

            Run(true)
            Run(false)
            """, "4", "9");
    }

    [Fact]
    public void ForwardGoto_BypassesConditionalValueAssignment_ReportsNullableReceiver()
    {
        var result = Evaluate("""
            func Run(jump bool, choose bool) int32 {
                var x string? = nil
                if jump { goto Done }
                x = if choose { "a" } else { "bb" }
            Done:
                return x.Length
            }

            Run(true, false)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGotoFromNestedScope_InvalidatesOnlyBypassedLocal()
    {
        var result = Evaluate("""
            func Run(jump bool) int32 {
                var safe string? = nil
                var skipped string? = nil
                safe = "safe"
                if jump {
                    if true {
                        goto Done
                    }
                }
                skipped = "skip"
            Done:
                return safe.Length + skipped.Length
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        var text = diagnostic.Location.Text.ToString();
        Assert.Equal(
            text.IndexOf("skipped.Length", StringComparison.Ordinal) + "skipped.".Length,
            diagnostic.Location.Span.Start);
    }

    [Fact]
    public void AssignmentAtTargetAfterOtherLabels_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var text string? = nil
                if jump { goto Assign }
            Other:
                Console.WriteLine("unreachable")
            Assign:
                Console.WriteLine("assign")
                text = "text"
                Console.WriteLine(text.Length)
            }

            Run(true)
            """, "assign", "4");
    }

    [Fact]
    public void NestedFunction_UsesIndependentGotoJoinState()
    {
        var result = Evaluate("""
            func Outer() int32 {
                var x string? = nil
                x = "outer"
                var inner = func(jump bool) int32 {
                    var y string? = nil
                    if jump { goto Done }
                    y = "inner"
                Done:
                    return y.Length
                }
                return x.Length + inner(true)
            }

            Outer()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void GotoLeavingTry_AppliesFinallyMutationBeforeLabelJoin()
    {
        var result = Evaluate("""
            func Run(jump bool) int32 {
                var x string? = nil
                x = "safe"
                try {
                    if jump { goto Done }
                } finally {
                    x = nil
                }
                x = "again"
            Done:
                return x.Length
            }

            Run(true)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void GotoLeavingTry_PreservesNarrowingWhenFinallyAssignsNonNull()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var x string? = nil
                x = "safe"
                try {
                    if jump { goto Done }
                } finally {
                    x = "final"
                }
                x = "again"
            Done:
                Console.WriteLine(x.Length)
            }

            Run(true)
            """, "5");
    }

    [Fact]
    public void GotoLeavingTry_UsesNarrowingEstablishedByFinally()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var x string? = nil
                try {
                    if jump { goto Done }
                } finally {
                    x = "final"
                }
                x = "again"
            Done:
                Console.WriteLine(x.Length)
            }

            Run(true)
            """, "5");
    }

    [Fact]
    public void GotoLeavingTry_AndFallthroughUseNarrowingEstablishedByFinally()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var x string? = nil
                try {
                    if jump { goto Done }
                } finally {
                    x = "final"
                }
            Done:
                Console.WriteLine(x.Length)
            }

            Run(false)
            Run(true)
            """, "5", "5");
    }

    [Fact]
    public void ConditionalFinallyAssignment_DoesNotEstablishNarrowing()
    {
        var result = Evaluate("""
            func Run(jump bool, assign bool) int32 {
                var x string? = nil
                try {
                    if jump { goto Done }
                } finally {
                    if assign { x = "final" }
                }
                x = "again"
            Done:
                return x.Length
            }

            Run(true, false)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
    }

    [Fact]
    public void LocalGotoInFinally_DoesNotDropNullableExitPath()
    {
        var result = Evaluate("""
            func Run(jump bool, skip bool) int32 {
                var x string? = nil
                try {
                    if jump { goto Done }
                } finally {
                    if skip {
                        x = nil
                        goto EndFinally
                    }
                    x = "safe"
                EndFinally:
                }
                x = "again"
            Done:
                return x.Length
            }

            Run(true, true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void LocalGotoInFinally_RemainsInMultipleGotoJoin()
    {
        var result = Evaluate("""
            func Run(throughFinally bool, direct bool, skip bool) int32 {
                var x string? = nil
                if throughFinally {
                    try {
                        goto Done
                    } finally {
                        if skip {
                            x = nil
                            goto EndFinally
                        }
                        x = "safe"
                    EndFinally:
                    }
                }
                x = "safe"
                if direct { goto Done }
            Done:
                return x.Length
            }

            Run(true, false, true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void NestedFinally_EstablishesNarrowingForOuterGoto()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var x string? = nil
                try {
                    if jump { goto Done }
                } finally {
                    try {
                    } finally {
                        x = "safe"
                    }
                }
                x = "again"
            Done:
                Console.WriteLine(x.Length)
            }

            Run(true)
            """, "4");
    }

    [Fact]
    public void NonCompletingFinally_DoesNotInvalidateFallthroughNarrowing()
    {
        AssertRuns("""
            import System

            func Run(jump bool) int32 {
                var x string? = nil
                if jump {
                    try {
                        goto Done
                    } finally {
                        return 0
                    }
                }
                x = "safe"
            Done:
                return x.Length
            }

            Console.WriteLine(Run(false))
            """, "4");
    }

    [Fact]
    public void LocalGotoInNonCompletingFinally_DoesNotInvalidateFallthroughNarrowing()
    {
        AssertRuns("""
            import System

            func Run(jump bool) int32 {
                var x string? = nil
                if jump {
                    try {
                        goto Done
                    } finally {
                        goto Exit
                    Exit:
                        return 0
                    }
                }
                x = "safe"
            Done:
                return x.Length
            }

            Console.WriteLine(Run(false))
            """, "4");
    }

    [Fact]
    public void NestedFunctionBetweenFinallyAndTarget_DoesNotLoseOuterFinallyEffects()
    {
        var result = Evaluate("""
            func Run(jump bool) int32 {
                var x string? = nil
                x = "safe"
                try {
                    if jump { goto Done }
                } finally {
                    x = nil
                }
                var helper = func() int32 {
                    try {
                        return 1
                    } finally {
                    }
                }
                x = "again"
            Done:
                return x.Length
            }

            Run(true)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    private static EmittedOracleResult Evaluate(string source)
        => EmittedOracle.Evaluate(source);

    private static void AssertRuns(string source, params string[] expectedLines)
    {
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            string.Join(Environment.NewLine, expectedLines) + Environment.NewLine,
            result.Output.ReplaceLineEndings(Environment.NewLine));
    }
}
