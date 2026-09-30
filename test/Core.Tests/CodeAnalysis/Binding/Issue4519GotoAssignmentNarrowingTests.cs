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
    public void BackwardGoto_GenericInterfaceMethodDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            interface Mapper {
                func Map[T](value T) T;
            }
            class First : Mapper {
                func Map[U](value U) U -> value
            }
            class Second : Mapper {
                func Map[V](value V) V -> value
            }

            func Run() string {
                var x Mapper = First{}
                var count = 0
                if x is First {
                Again:
                    let value = x.Map("safe")
                    if count == 0 {
                        count++
                        x = Second{}
                        goto Again
                    }
                    return value
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("safe", result.Value);
    }

    [Fact]
    public void ForwardGoto_NestedDeferRunsBeforeOuterFinally()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                try {
                    {
                        defer clear()
                        goto Done
                    }
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
    public void ForwardGoto_OuterFinallyRunsAfterNestedDefer()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                let restore = func() { x = "safe" }
                try {
                    {
                        defer restore()
                        goto Done
                    }
                }
                finally {
                    x = nil
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
                    x = Animal{}
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
    public void BackwardGoto_NullableUserMethodReceiverStillRequiresNonNull()
    {
        var result = Evaluate("""
            open class Animal {
                func Name() string { return "animal" }
            }
            class Dog : Animal {
            }

            func Run() string {
                var x Animal? = nil
                x = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let name = x.Name()
                    if count == 0 {
                        count++
                        x = nil
                        goto Again
                    }
                    return name
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("Name", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InheritedPropertyDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
                prop Name string -> "animal"
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
                    let name = x.Name
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
    public void BackwardGoto_InheritedFieldDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
                var Name string = "animal"
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
                    let name = x.Name
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
    public void BackwardGoto_InheritedImportedCallDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
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
                    let text = x.ToString()
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return count
                }
                return 0
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void BackwardGoto_InheritedPropertyWriteDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
                prop Name string { get; set; }
            }
            class Dog : Animal {
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    x.Name = "updated"
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return x.Name
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("updated", result.Value);
    }

    [Fact]
    public void BackwardGoto_OverriddenPropertyWriteUsesDeclaredSlot()
    {
        var result = Evaluate("""
            open class Animal {
                open prop Name string { get; set; }
            }
            class Dog : Animal {
                override prop Name string { get; set; }
            }
            class Cat : Animal {
                override prop Name string { get; set; }
            }

            func Run() string {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    x.Name = "updated"
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return x.Name
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("updated", result.Value);
    }

    [Fact]
    public void BackwardGoto_InheritedFieldWriteDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
                var Name string = "animal"
            }
            class Dog : Animal {
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    x.Name = "updated"
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return x.Name
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("updated", result.Value);
    }

    [Fact]
    public void BackwardGoto_SubtypeOnlyPropertyWriteStillRequiresNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                prop Sound string { get; set; }
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    x.Sound = "bark"
                    x = Cat{}
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Sound", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_SubtypeOnlyFieldWriteStillRequiresNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                var Sound string = "woof"
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    x.Sound = "bark"
                    x = Cat{}
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Sound", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_SubtypeOnlyPropertyStillRequiresNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                prop Sound string -> "woof"
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    let sound = x.Sound
                    x = Cat{}
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Sound", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_SubtypeOnlyFieldStillRequiresNarrowedType()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                var Sound string = "woof"
            }
            class Cat : Animal {
            }

            func Run() string {
                var x Animal = Dog{}
                if x is Dog {
                Again:
                    let sound = x.Sound
                    x = Cat{}
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Sound", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_HiddenPropertyKeepsSelectedSubtypeSlot()
    {
        AssertRuns("""
            import System

            open class Animal {
                prop Name string -> "animal"
            }
            class Dog : Animal {
                prop Name string -> "dog"
            }

            func Run() string {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let name = x.Name
                    if count == 0 {
                        count++
                        goto Again
                    }
                    return name
                }
                return ""
            }

            Console.WriteLine(Run())
            """, "dog");
    }

    [Fact]
    public void BackwardGoto_HiddenFieldKeepsSelectedSubtypeSlot()
    {
        AssertRuns("""
            import System

            open class Animal {
                var Name string = "animal"
            }
            class Dog : Animal {
                var Name string = "dog"
            }

            func Run() string {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let name = x.Name
                    if count == 0 {
                        count++
                        goto Again
                    }
                    return name
                }
                return ""
            }

            Console.WriteLine(Run())
            """, "dog");
    }

    [Fact]
    public void BackwardGoto_HiddenPropertyWriteKeepsSelectedSubtypeSlot()
    {
        var result = Evaluate("""
            open class Animal {
                var value string = "animal"
                prop Name string {
                    get { return this.value }
                    set(next) { this.value = next }
                }
            }
            class Dog : Animal {
                var value string = "dog"
                prop Name string {
                    get { return this.value }
                    set(next) { this.value = next }
                }
            }

            func Run() string {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    x.Name = "selected"
                    if count == 0 {
                        count++
                        goto Again
                    }
                    return x.Name
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("selected", result.Value);
    }

    [Fact]
    public void BackwardGoto_HiddenFieldWriteKeepsSelectedSubtypeSlot()
    {
        var result = Evaluate("""
            open class Animal {
                var Name string = "animal"
            }
            class Dog : Animal {
                var Name string = "dog"
            }

            func Run() string {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    x.Name = "selected"
                    if count == 0 {
                        count++
                        goto Again
                    }
                    return x.Name
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("selected", result.Value);
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
    public void BackwardGoto_ConstructedGenericInterfaceIndexerDoesNotRequireNarrowedType()
    {
        var result = Evaluate("""
            interface Values[T] {
                prop this[index int32] T { get; }
            }
            class Dog : Values[string] {
                prop this[index int32] string -> "dog"
            }
            class Cat : Values[string] {
                prop this[index int32] string -> "cat"
            }

            func Run() string {
                var x Values[string] = Dog{}
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
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("cat", result.Value);
    }

    [Fact]
    public void BackwardGoto_NullableInterfaceIndexerStillRequiresNonNullReceiver()
    {
        var result = Evaluate("""
            interface Values {
                prop this[index int32] int32 { get; }
            }
            class Dog : Values {
                prop this[index int32] int32 -> 1
            }

            func Run() int32 {
                var x Values? = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let value = x[0]
                    if count == 0 {
                        count++
                        x = nil
                        goto Again
                    }
                    return value
                }
                return 0
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0116");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
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
    public void BackwardGoto_TracksSelectedInheritedIndexerOverload()
    {
        var result = Evaluate("""
            interface IntValues {
                prop this[index int32] string { get; }
            }
            interface TextValues {
                prop this[index string] string { get; }
            }
            interface BothValues : TextValues, IntValues {
            }
            class Dog : BothValues {
                prop this[index int32] string -> "int"
                prop this[index string] string -> "text"
            }
            class IntOnly : IntValues {
                prop this[index int32] string -> "int"
            }

            func Run() string {
                var x IntValues = Dog{}
                var count = 0
                if x is BothValues {
                Again:
                    let value = x["key"]
                    if count == 0 {
                        count++
                        x = IntOnly{}
                        goto Again
                    }
                    return value
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
    public void BackwardGoto_TracksSelectedInheritedIndexerWriteOverload()
    {
        var result = Evaluate("""
            interface IntValues {
                prop this[index int32] string { get; set; }
            }
            interface TextValues {
                prop this[index string] string { get; set; }
            }
            interface BothValues : TextValues, IntValues {
            }
            class Dog : BothValues {
                prop this[index int32] string { get -> "int" set { } }
                prop this[index string] string { get -> "text" set { } }
            }
            class IntOnly : IntValues {
                prop this[index int32] string { get -> "int" set { } }
            }

            func Run() {
                var x IntValues = Dog{}
                var count = 0
                if x is BothValues {
                Again:
                    x["key"] = "value"
                    if count == 0 {
                        count++
                        x = IntOnly{}
                        goto Again
                    }
                }
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
    public void BackwardGoto_ImportedMemberPathConversionRetainsDeclaredNullability()
    {
        var result = EmittedOracle.Evaluate(
            """
            import GSharp.Core.Tests.CodeAnalysis.Binding

            func Run() string {
                var box = Issue4519ImportedGenericHolder[string?]("safe")
                if box.Value != nil {
                Again:
                    let value string = box.Value
                    box = Issue4519ImportedGenericHolder[string?](nil)
                    goto Again
                }
                return ""
            }

            Run()
            """,
            new[] { typeof(Issue4519ImportedGenericHolder<>).Assembly.Location });

        var diagnostics = result.Diagnostics.Where(d => d.Id == "GS0155").ToArray();
        Assert.Equal(2, diagnostics.Length);
        Assert.All(
            diagnostics,
            diagnostic => Assert.Contains("'string?'", diagnostic.Message, StringComparison.Ordinal));
        Assert.Contains(
            diagnostics,
            diagnostic => diagnostic.Location.Text.ToString(diagnostic.Location.Span) == "box.Value");
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
    public void ForwardGoto_JoinsFallthroughAndIncomingToCommonSupertype()
    {
        var result = Evaluate("""
            open class Animal {
                prop Name string -> "animal"
            }
            class Dog : Animal {
            }

            func Run(jump bool) string {
                var x Animal? = nil
                if jump {
                    x = Animal{}
                    goto Use
                }
                x = Dog{}
            Use:
                return x.Name
            }

            Run(true)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("animal", result.Value);
    }

    [Fact]
    public void ForwardGoto_JoinsSiblingAssignmentsToDeclaredSupertype()
    {
        var result = Evaluate("""
            open class Animal {
                prop Name string -> "animal"
            }
            class Dog : Animal {
            }
            class Cat : Animal {
            }

            func Run(jump bool) string {
                var x Animal? = nil
                if jump {
                    x = Cat{}
                    goto Use
                }
                x = Dog{}
            Use:
                return x.Name
            }

            Run(true)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("animal", result.Value);
    }

    [Fact]
    public void ForwardGoto_DoesNotJoinNumericWideningWithoutConversion()
    {
        var result = Evaluate("""
            func Run() int64 {
                var x object = int32(1)
                if x is int32 {
                    goto Use
                }
                if x is int64 {
                Use:
                    return x
                }
                return 0
            }

            Run()
            """);

        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains(
                "Cannot convert type 'object' to 'int64'",
                StringComparison.Ordinal));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_DoesNotAcceptNumericWideningWithoutConversion()
    {
        var result = Evaluate("""
            func Run() int64 {
                var x object = int64(1)
                var count = 0
                if x is int64 {
                Again:
                    let value int64 = x
                    if count == 0 {
                        count++
                        x = int32(2)
                        if x is int32 {
                            goto Again
                        }
                    }
                    return value
                }
                return 0
            }

            Run()
            """);

        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains(
                "Cannot convert type 'object' to 'int64'",
                StringComparison.Ordinal));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_JoinDoesNotOverwriteShadowedOuterFrame()
    {
        var result = Evaluate("""
            open class Animal {
            }
            class Dog : Animal {
                prop Sound string -> "woof"
            }
            class Cat : Animal {
            }

            func GetAnimal() Animal -> Cat{}

            func Run() string {
                var x Animal? = nil
                x = GetAnimal()
                if x is Dog {
                    goto Join
                Join:
                    var marker = 0
                }
                return x.Sound
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Sound", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
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
    public void ForwardGoto_FinallyIncludesCallableArgumentBodyMutation()
    {
        var result = Evaluate("""
            func Invoke(action (() -> void)) {
                action()
            }

            func Run() int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                try {
                    goto Done
                }
                finally {
                    Invoke(clear)
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
    public void ForwardGoto_FinallyIncludesImportedCallableArgumentBodyMutation()
    {
        var result = Evaluate("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                var values = []int32{1}
                try {
                    goto Done
                }
                finally {
                    Array.ForEach(values, func(value int32) { x = nil })
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
    public void ForwardGoto_FinallyTreatsMixedExternalAndUnknownCallableAsUnsafe()
    {
        var result = Evaluate("""
            data class Holder(Callback (() -> void)) {
            }

            func Run(external (() -> void), chooseLocal bool) int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                let holder = Holder{Callback: clear}
                try {
                    goto Done
                }
                finally {
                    var action = external
                    if chooseLocal {
                        action = holder.Callback
                    }
                    action()
                }
            Done:
                return x.Length
            }

            Run(func() { }, true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyIncludesCapturedGenericLocalFunctionMutation()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                try {
                    goto Done
                }
                finally {
                    let mutate[T] = func(seed T) { x = nil }
                    mutate(0)
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
    public void ForwardGoto_FinallyPreservesCallableTargetAcrossZeroIterationLoop()
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
                    let noop = func() { }
                    var action (() -> void) = mutate
                    for _ in []int32{} {
                        action = noop
                    }
                    action()
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
    public void ForwardGoto_FinallyIncludesLoopCarriedCallableTarget()
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
                    let noop = func() { }
                    var a (() -> void) = noop
                    var b (() -> void) = noop
                    var c (() -> void) = mutate
                    for _ in []int32{0, 1} {
                        a = b
                        b = c
                        c = noop
                    }
                    a()
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
    public void ForwardGoto_FinallyReanalyzesCallableWithUpdatedAliasState()
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
                    let noop = func() { }
                    var action (() -> void) = noop
                    let invoke = func() { action() }
                    invoke()
                    action = mutate
                    invoke()
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
    public void ForwardGoto_FinallyCatchIncludesIntermediateCallableTarget()
    {
        var result = Evaluate("""
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
                    var action (() -> void) = noop
                    try {
                        action = mutate
                        throw Exception()
                        action = noop
                    }
                    catch {
                        action()
                    }
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
    public void ForwardGoto_FinallyUsesUnconditionalCallableTargetAfterLoop()
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
                    for _ in []int32{} {
                        action = mutate
                    }
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
    public void ForwardGoto_FinallyPreservesCallableTargetAcrossUnconditionalGoto()
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
                    let noop = func() { }
                    var action (() -> void) = mutate
                    goto Invoke
                    action = noop
                Invoke:
                    action()
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
    public void ForwardGoto_FinallyPreservesCallableTargetAcrossSwitchArms()
    {
        var result = Evaluate("""
            func Run(value int32) int32 {
                var x string? = nil
                x = "safe"
                try {
                    goto Done
                }
                finally {
                    let mutate = func() { x = nil }
                    let noop = func() { }
                    var action (() -> void) = mutate
                    switch value {
                        case 1 { action = noop }
                        default { }
                    }
                    action()
                }
            Done:
                return x.Length
            }

            Run(0)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyPreservesCallableTargetAcrossCatchBranches()
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
                    let noop = func() { }
                    var action (() -> void) = mutate
                    try {
                    }
                    catch {
                        action = noop
                    }
                    action()
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
    public void Fallthrough_DeferAliasCleanupInvalidatesNarrowing()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                {
                    defer clear()
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
    public void CapturedFunctionCall_PreservesReadonlyLocalNarrowing()
    {
        var result = Evaluate("""
            func Run(present bool) int32 {
                let text string? = if present { "safe" } else { nil }
                if text == nil {
                    return 0
                }
                var calls = 0
                let count = func() { calls++ }
                count()
                return text.Length
            }

            Run(true)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void ForwardGoto_FinallyPreservesExternalCallableAliasesAcrossJoin()
    {
        var result = Evaluate("""
            func Run(callback (() -> void), choose bool) int32 {
                var text string? = nil
                text = "safe"
                let alias (() -> void) = callback
                try {
                    goto Done
                }
                finally {
                    var action (() -> void) = alias
                    if choose {
                        action = callback
                    }
                    else {
                        action = alias
                    }
                    action()
                }
            Done:
                return text.Length
            }

            Run(func() { }, true)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void ForwardGoto_DeferUsesCallableAliasStateFromEachEdge()
    {
        var result = Evaluate("""
            func Noop() {
            }

            func Run(choose bool) int32 {
                var text string? = nil
                text = "safe"
                let clear = func() { text = nil }
                var action = Noop
                {
                    defer action()
                    if !choose { goto Safe }
                    action = clear
                    goto Done
                Safe:
                    {
                    }
                    action = Noop
                    goto Done
                }
            Done:
                return text.Length
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyPreservesAssignedExternalCallableAlias()
    {
        AssertRuns("""
            import System

            func Noop() {
            }

            func Run(callback (() -> void)) int32 {
                var text string? = nil
                text = "safe"
                var action = Noop
                action = callback
                try {
                    goto Done
                }
                finally {
                    action()
                }
            Done:
                return text.Length
            }

            Console.WriteLine(Run(Noop))
            """, "4");
    }

    [Fact]
    public void ForwardGoto_FinallyPreservesExternalCallableAliasAssignedInNestedBlock()
    {
        AssertRuns("""
            import System

            func Noop() {
            }

            func Run(callback (() -> void)) int32 {
                var text string? = nil
                text = "safe"
                var action = Noop
                {
                    action = callback
                }
                try {
                    goto Done
                }
                finally {
                    action()
                }
            Done:
                return text.Length
            }

            Console.WriteLine(Run(Noop))
            """, "4");
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
    public void ForwardGoto_EnteringInfiniteLoopBreakPropagatesReachability()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                goto Enter
                for {
                Enter:
                    break
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
    public void ForwardGoto_EnteringFiniteLoopContinuePropagatesReachability()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                goto Enter
                for _ in []int32{0} {
                Enter:
                    continue
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
    public void ForwardGoto_EnteringLoweredLoopContinuePropagatesReachability()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                var keepGoing = true
                goto Enter
                for keepGoing {
                Enter:
                    keepGoing = false
                    continue
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
    public void ForwardGoto_EnteringSwitchBreakPropagatesReachability()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                goto Enter
                switch 0 {
                    case 0 {
                    Enter:
                        break
                    }
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
    public void ForwardGoto_EnteringSwitchFallthroughPropagatesReachability()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                goto Enter
                switch 0 {
                    case 0 {
                    Enter:
                        {
                        }
                        fallthrough
                    }
                    case 1 {
                    }
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
    public void ForwardGoto_EnteringTryPropagatesReachabilityIntoFinally()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
            Again:
                let length = x.Length
                goto Enter
                try {
                Enter:
                    var marker = 0
                }
                finally {
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
    public void ForwardGoto_EnteringTryPropagatesReachabilityIntoCatch()
    {
        var result = Evaluate("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
            Again:
                let length = x.Length
                goto Enter
                try {
                Enter:
                    throw InvalidOperationException()
                }
                catch {
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
    public void NestedFunctionLabelDoesNotMakeOuterFinallyReachable()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                goto Assign
                try {
                    let nested = func() {
                        goto Inner
                    Inner:
                        return
                    }
                }
                finally {
                    goto Done
                }
            Assign:
                x = "safe"
            Done:
                return x.Length
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
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
    public void ForwardGoto_IntoNestedLabeledElseDoesNotLiftOuterGuard()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                goto Inside
            Guard:
                if x == nil {
                    return 0
                } else {
                Inside:
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
    public void BackwardGoto_ThroughFinallyIndirectAliasMutation_ReportsNullableReceiver()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                let p = &x
                x = "safe"
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    try {
                        goto Again
                    } finally {
                        *p = nil
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
    public void ForwardGoto_IntoNestedGuardsRemovesAllStaleProofs()
    {
        var result = Evaluate("""
            open class Animal {
                var Name string = "animal"
            }
            class Dog : Animal {
            }

            func Run(jump bool) string {
                var x Animal? = nil
                if jump { goto Use }
                if x != nil {
                    if x is Dog {
                    Use:
                        return x.Name
                    }
                }
                return ""
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Name", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
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
    public void UnreachableBackedgeAfterInfiniteLoopDoesNotInvalidateNarrowing()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
            Again:
                let length = x.Length
                for {
                }
                x = nil
                goto Again
                return length
            }

            0
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void UnreachableBackedgeAfterExhaustiveSwitchDoesNotInvalidateNarrowing()
    {
        var result = Evaluate("""
            func Run(value object) int32 {
                var x string? = nil
                x = "safe"
            Again:
                let length = x.Length
                switch value {
                    case _ {
                        return length
                    }
                }
                x = nil
                goto Again
            }

            0
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BackwardGoto_MemberPathRecoversDeclaredBaseMethod()
    {
        var result = Evaluate("""
            open class Animal {
                open func Read() string -> "animal"
            }
            class Dog : Animal {
            }
            class Cat : Animal {
            }
            data class Holder(Value Animal) {
            }

            func Run() string {
                var holder = Holder(Dog{})
                var count = 0
                if holder.Value is Dog {
                Again:
                    let value = holder.Value.Read()
                    if count == 0 {
                        count++
                        holder = Holder(Cat{})
                        goto Again
                    }
                    return value
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("animal", result.Value);
    }

    [Fact]
    public void BackwardGoto_DoesNotReuseSiblingMemberPathProof()
    {
        var result = Evaluate("""
            import System

            class Box {
                prop Value string? { get; init; }
            }

            func Run() int32 {
                var box = Box() { Value = "safe" }
                var count = 0
                var length = 0
                if box.Value != nil {
                Again: {
                        if box.Value != nil {
                            let value string = box.Value
                            length = value.Length
                        }
                        if count == 0 {
                            count++
                            box = Box() { Value = nil }
                            goto Again
                        }
                    }
                }
                return length
            }

            Console.WriteLine(Run())
            """);

        Assert.True(
            result.Diagnostics.IsEmpty,
            string.Join(
                Environment.NewLine,
                result.Diagnostics.Select(diagnostic =>
                    $"{diagnostic.Id} {diagnostic.Location.Text.ToString(diagnostic.Location.Span)}: {diagnostic.Message}")));
        Assert.Equal($"4{Environment.NewLine}", result.Output.ReplaceLineEndings(Environment.NewLine));
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

    [Fact]
    public void BackwardGoto_OverriddenIndexerWriteUsesDeclaredSlot()
    {
        var result = Evaluate("""
            open class Animal {
                open prop this[index int32] string {
                    get { return "" }
                    set(value) { }
                }
            }
            class Dog : Animal {
                override prop this[index int32] string {
                    get { return "" }
                    set(value) { }
                }
            }
            class Cat : Animal {
                override prop this[index int32] string {
                    get { return "" }
                    set(value) { }
                }
            }

            func Run() int32 {
                var x Animal = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    x[0] = "safe"
                    if count == 0 {
                        count++
                        x = Cat{}
                        goto Again
                    }
                    return count
                }
                return 0
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void LabeledTryFinallyPropagatesNonNullAssignment()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
            Cleanup:
                try {
                    var marker = 0
                }
                finally {
                    x = "safe"
                }
                return x.Length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void BackwardConditionalGotoDoesNotKeepOldCallableTargetPending()
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
                    var action = mutate
                    var retry = true
                Loop:
                    if retry {
                        retry = false
                        goto Loop
                    }
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
    public void BackwardGoto_ChangedCallableTargetAlreadyInvalidatesCapturedRoot()
    {
        var result = Evaluate("""
            data class Holder(Callback (() -> void)) {
            }

            func Run(external (() -> void)) int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                let holder = Holder{Callback: clear}
                try {
                    goto Done
                }
                finally {
                    var action = external
                    var retry = true
                Again:
                    action()
                    if retry {
                        retry = false
                        action = holder.Callback
                        goto Again
                    }
                }
            Done:
                return x.Length
            }

            Run(func() { })
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void UninvokedNestedFunction_DoesNotLeakCallableAliasState()
    {
        var result = Evaluate("""
            func Noop() {
            }

            func Run() int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                var action = clear
                let unused = func() { action = Noop }
                try {
                    goto Done
                } finally {
                    action()
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
    public void ForwardReachabilityActivatesOutgoingGotoFromEarlierLabel()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                goto After
            Enter:
                x = nil
                goto Use
            After:
                goto Enter
            Use:
                return x.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void NestedFunctionActivatesDeferredReachableGotoEdges()
    {
        var result = Evaluate("""
            let run = func() int32 {
                var x string? = nil
                x = "safe"
                goto After
            Enter:
                x = nil
                goto Use
            After:
                goto Enter
            Use:
                return x.Length
            }

            run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void CallableArgumentWithKnownAndUnknownTargetsRemainsUnsafe()
    {
        var result = Evaluate("""
            data class Holder(Callback (() -> void)) {
            }

            func Invoke(action (() -> void)) {
                action()
            }

            func Run(chooseUnknown bool) int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                let holder = Holder{Callback: clear}
                try {
                    goto Done
                }
                finally {
                    let noop = func() { }
                    var action = noop
                    if chooseUnknown {
                        action = holder.Callback
                    }
                    Invoke(action)
                }
            Done:
                return x.Length
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void CallableArgumentWithExternalAndUnknownTargetsRemainsUnsafe()
    {
        var result = Evaluate("""
            data class Holder(Callback (() -> void)) {
            }

            func Invoke(action (() -> void)) {
                action()
            }

            func Run(callback (() -> void), chooseUnknown bool) int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                let holder = Holder{Callback: clear}
                try {
                    goto Done
                }
                finally {
                    var action = callback
                    if chooseUnknown {
                        action = holder.Callback
                    }
                    Invoke(action)
                }
            Done:
                return x.Length
            }

            Run(func() { }, true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_LabelJoinIntersectsExternalCallableAliases()
    {
        var result = Evaluate("""
            func Noop() {
            }

            func Run(takeJump bool) int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                var action = clear
                if takeJump {
                    goto Joined
                }
                action = Noop
            Joined:
                try {
                    goto Done
                }
                finally {
                    action()
                }
            Done:
                return x.Length
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_LabelJoinIncludesCleanupCallableReassignment()
    {
        var result = Evaluate("""
            func Noop() {
            }

            func Run(takeJump bool) int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                var action = Noop
                if takeJump {
                    try {
                        goto Joined
                    }
                    finally {
                        action = clear
                    }
                }
                action = Noop
            Joined:
                try {
                    goto Done
                }
                finally {
                    action()
                }
            Done:
                return x.Length
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void LabeledDirectExternalCallableAssignmentPreservesLocalNarrowing()
    {
        AssertRuns("""
            import System

            func Run(callback (() -> void)) int32 {
                var x string? = nil
                x = "safe"
                let clear = func() { x = nil }
                var action = clear
            Assign:
                action = callback
                try {
                    goto Done
                }
                finally {
                    action()
                }
            Done:
                return x.Length
            }

            Console.WriteLine(Run(func() { }))
            """, "4");
    }

    [Fact]
    public void ForwardGoto_WeakeningInnerProofRemovesShadowedOuterProof()
    {
        var result = Evaluate("""
            open class Animal {
                func Name() string -> "animal"
            }
            class Dog : Animal {
                func Bark() string -> "dog"
            }
            class Cat : Animal {
            }

            func Run(takeJump bool) string {
                var x Animal = Animal{}
                if takeJump {
                    x = Cat{}
                    goto Joined
                }
                x = Dog{}
                if x is Dog {
                Joined:
                    let name = x.Name()
                }
                return x.Bark()
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("Bark()", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void RepresentationPreservingJoinRejectsPlatformCheckedConversion()
    {
        Assert.False(GSharp.Core.CodeAnalysis.Binding.Conversion.IsRepresentationPreservingImplicit(
            GSharp.Core.CodeAnalysis.Symbols.PlatformTypeSymbol.Get(
                GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.String),
            GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.String));
    }

    [Fact]
    public void ForwardGoto_FinallyUsesCallableStateAtEntry()
    {
        var result = Evaluate("""
            func Run(callback (() -> void)) int32 {
                var text string? = nil
                text = "safe"
                let clear = func() { text = nil }
                var action = clear
                try {
                    goto Done
                }
                finally {
                    text = "safe"
                    action()
                    action = callback
                }
            Done:
                return text.Length
            }

            Run(func() { })
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyConditionalOutInvalidatesBothPossibleRoots()
    {
        var result = Evaluate("""
            func Clear(out value string?) {
                value = nil
            }

            func Run(clearText bool) int32 {
                var text string? = nil
                var other string? = nil
                text = "safe"
                other = "safe"
                try {
                    goto Done
                }
                finally {
                    Clear(out (clearText ? text : other))
                }
            Done:
                return text.Length
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyPreservesMutableAliasInitializedFromReadonlyCallback()
    {
        AssertRuns("""
            import System

            func Run(callback (() -> void)) int32 {
                var text string? = nil
                text = "safe"
                var action = callback
                try {
                    goto Done
                }
                finally {
                    action()
                }
            Done:
                return text.Length
            }

            Console.WriteLine(Run(func() { }))
            """, "4");
    }

    [Fact]
    public void ForwardGoto_FinallyExternalCallbackInvalidatesWritableRefParameter()
    {
        var result = Evaluate("""
            func Run(ref text string?, callback (() -> void)) int32 {
                text = "safe"
                try {
                    goto Done
                }
                finally {
                    callback()
                }
            Done:
                return text.Length
            }

            func Outer() int32 {
                var text string? = nil
                let clear = func() { text = nil }
                return Run(ref text, clear)
            }

            Outer()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallyBranchJoinUsesCallableStateBeforeIf()
    {
        var result = Evaluate("""
            func Run(callback (() -> void), keepClear bool) int32 {
                var text string? = nil
                text = "safe"
                let clear = func() { text = nil }
                var action = clear
                if keepClear {
                }
                else {
                    action = callback
                }
                try {
                    goto Done
                }
                finally {
                    action()
                }
            Done:
                return text.Length
            }

            Run(func() { }, true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_NonCompletingInfiniteFinallyDoesNotActivateEdge()
    {
        AssertRuns("""
            import System

            func Run(takeInfinitePath bool) int32 {
                var text string? = nil
                if takeInfinitePath {
                    try {
                        goto Done
                    }
                    finally {
                        for {
                        }
                    }
                }
                text = "safe"
            Done:
                return text.Length
            }

            Console.WriteLine(Run(false))
            """, "4");
    }

    [Fact]
    public void ImportedCallRecovery_DoesNotRebindInlineOutVariable()
    {
        var result = EmittedOracle.Evaluate(
            """
            import GSharp.Core.Tests.CodeAnalysis.Binding

            func Run() int32 {
                var x Issue4519ImportedCallReceiver = Issue4519ImportedCallDog()
                var count = 0
                if x is Issue4519ImportedCallDog {
                Again:
                    let found = x.TryRead("value", out var value)
                    if count == 0 {
                        count++
                        x = Issue4519ImportedCallCat()
                        goto Again
                    }
                    return if found { value } else { 0 }
                }
                return 0
            }

            Run()
            """,
            new[] { typeof(Issue4519ImportedCallReceiver).Assembly.Location });

        Assert.Empty(result.Diagnostics);
        Assert.Equal(22, result.Value);
    }

    [Fact]
    public void ImportedCallRecovery_DoesNotRebindCapturedLambda()
    {
        var result = EmittedOracle.Evaluate(
            """
            import GSharp.Core.Tests.CodeAnalysis.Binding

            func Run() int32 {
                var x Issue4519ImportedCallReceiver = Issue4519ImportedCallDog()
                let offset = 3
                var count = 0
                if x is Issue4519ImportedCallDog {
                Again:
                    let value = x.Apply((item int32) -> item + offset)
                    if count == 0 {
                        count++
                        x = Issue4519ImportedCallCat()
                        goto Again
                    }
                    return value
                }
                return 0
            }

            Run()
            """,
            new[] { typeof(Issue4519ImportedCallReceiver).Assembly.Location });

        Assert.Empty(result.Diagnostics);
        Assert.Equal(25, result.Value);
    }

    [Fact]
    public void BackwardGoto_PublicPropertyDoesNotAliasExplicitInterfaceProperty()
    {
        var result = Evaluate("""
            interface View {
                prop Value string { get; }
            }
            class Dog : View {
                prop Value string -> "public"
                private prop (View) Value string -> "explicit"
            }

            func Run() string {
                var x View = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let value = x.Value
                    if count == 0 {
                        count++
                        goto Again
                    }
                    return value
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("public", result.Value);
    }

    [Fact]
    public void BackwardGoto_PublicPropertyDoesNotAliasInheritedExplicitInterfaceProperty()
    {
        var result = Evaluate("""
            interface View {
                prop Value string { get; }
            }
            open class Base : View {
                private prop (View) Value string -> "explicit"
            }
            class Dog : Base {
                prop Value string -> "public"
            }

            func Run() string {
                var x View = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let value = x.Value
                    if count == 0 {
                        count++
                        goto Again
                    }
                    return value
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("public", result.Value);
    }

    [Fact]
    public void BackwardGoto_PublicIndexerDoesNotAliasInheritedExplicitInterfaceIndexer()
    {
        var result = Evaluate("""
            interface View {
                prop this[index int32] string { get; }
            }
            open class Base : View {
                private prop (View) this[index int32] string -> "explicit"
            }
            class Dog : Base {
                prop this[index int32] string -> "public"
            }

            func Run() string {
                var x View = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let value = x[0]
                    if count == 0 {
                        count++
                        goto Again
                    }
                    return value
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("public", result.Value);
    }

    [Fact]
    public void BackwardGoto_PublicMethodDoesNotAliasExplicitInterfaceMethod()
    {
        var result = Evaluate("""
            interface View {
                func Read() string;
            }
            class Dog : View {
                func Read() string -> "public"
                private func (View) Read() string -> "explicit"
            }

            func Run() string {
                var x View = Dog{}
                var count = 0
                if x is Dog {
                Again:
                    let value = x.Read()
                    if count == 0 {
                        count++
                        goto Again
                    }
                    return value
                }
                return ""
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("public", result.Value);
    }

    [Fact]
    public void BackwardGoto_SiblingInterfacePropertySlotsDoNotAlias()
    {
        var result = Evaluate("""
            interface Left {
                prop Value string { get; }
            }
            interface Right {
                prop Value string { get; }
            }
            class Dog : Left, Right {
                private prop (Left) Value string -> "left"
                prop Value string -> "right"
            }
            class Cat : Left {
                prop Value string -> "cat"
            }

            func Run() string {
                var x Left = Dog{}
                if x is Right {
                Again:
                    let value = x.Value
                    x = Cat{}
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Value", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_ImportedPublicMethodDoesNotAliasExplicitInterfaceMethod()
    {
        var result = EmittedOracle.Evaluate(
            """
            import GSharp.Core.Tests.CodeAnalysis.Binding

            func Run() string {
                var x Issue4519ImportedCallReceiver = Issue4519ImportedCallDog()
                var count = 0
                if x is Issue4519ImportedCallDog {
                Again:
                    let value = x.Describe()
                    if count == 0 {
                        count++
                        goto Again
                    }
                    return value
                }
                return ""
            }

            Run()
            """,
            new[] { typeof(Issue4519ImportedCallReceiver).Assembly.Location });

        Assert.Empty(result.Diagnostics);
        Assert.Equal("public", result.Value);
    }

    [Fact]
    public void BackwardGoto_ImportedRefReturnsRecoverDeclaredBaseSlots()
    {
        var result = EmittedOracle.Evaluate(
            """
            import GSharp.Core.Tests.CodeAnalysis.Binding

            func Run() int32 {
                var x Issue4519ImportedRefBase = Issue4519ImportedRefDog()
                var count = 0
                if x is Issue4519ImportedRefDog {
                Again:
                    let value = x.Value + x.Read()
                    if count == 0 {
                        count++
                        x = Issue4519ImportedRefCat()
                        goto Again
                    }
                    return value
                }
                return 0
            }

            Run()
            """,
            new[] { typeof(Issue4519ImportedRefBase).Assembly.Location });

        Assert.Empty(result.Diagnostics);
        Assert.Equal(44, result.Value);
    }

    [Fact]
    public void ForwardGoto_FinallyDirectSourceCallInvalidatesGlobalNarrowing()
    {
        var result = Evaluate("""
            var text string? = nil

            func Clear() {
                text = nil
            }

            func Run() int32 {
                text = "safe"
                try {
                    goto Done
                }
                finally {
                    Clear()
                }
            Done:
                return text.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallySourcePropertyReadInvalidatesGlobalNarrowing()
    {
        var result = Evaluate("""
            var text string? = nil

            class Trigger {
                prop Value int32 {
                    get {
                        text = nil
                        return 0
                    }
                }
            }

            func Run() int32 {
                text = "safe"
                let trigger = Trigger()
                try {
                    goto Done
                }
                finally {
                    let ignored = trigger.Value
                }
            Done:
                return text.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallySourcePropertyWriteInvalidatesGlobalNarrowing()
    {
        var result = Evaluate("""
            var text string? = nil

            class Trigger {
                prop Value int32 {
                    get -> 0
                    set {
                        text = nil
                    }
                }
            }

            func Run() int32 {
                text = "safe"
                let trigger = Trigger()
                try {
                    goto Done
                }
                finally {
                    trigger.Value = 1
                }
            Done:
                return text.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGoto_FinallySourcePropertyReadInvalidatesMemberPathNarrowing()
    {
        var result = Evaluate("""
            data class Box(Value string?) {
            }

            class Trigger {
                let action (() -> void)

                init(action (() -> void)) {
                    this.action = action
                }

                prop Value int32 {
                    get {
                        action()
                        return 0
                    }
                }
            }

            func Run() int32 {
                var box = Box("safe")
                let trigger = Trigger(func() { box = Box(nil) })
                if box.Value != nil {
                    try {
                        goto Done
                    }
                    finally {
                        let ignored = trigger.Value
                    }
                Done:
                    return box.Value.Length
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
    public void ForwardGoto_FinallySourceConstructionInvalidatesGlobalNarrowing()
    {
        var result = Evaluate("""
            var text string? = nil

            class Trigger {
                init() {
                    text = nil
                }
            }

            func Run() int32 {
                text = "safe"
                try {
                    goto Done
                }
                finally {
                    Trigger()
                }
            Done:
                return text.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_MemberPathDeclaredBaseConversionRemainsValid()
    {
        AssertRuns("""
            import System

            open class Animal {
                open func Name() string -> "animal"
            }
            class Dog : Animal {
                override func Name() string -> "dog"
            }
            class Cat : Animal {
                override func Name() string -> "cat"
            }
            data class Holder(Pet Animal) {
            }

            func Run() string {
                var holder = Holder(Dog{})
                var count = 0
                if holder.Pet is Dog {
                Again:
                    let animal Animal = holder.Pet
                    if count == 0 {
                        count++
                        holder = Holder(Cat{})
                        goto Again
                    }
                    return animal.Name()
                }
                return ""
            }

            Console.WriteLine(Run())
            """, "cat");
    }

    [Fact]
    public void BackwardGoto_CapturedSiblingAssignmentPreservesDeclaredBaseConversion()
    {
        var result = Evaluate("""
            open class Animal {
                open func Read() string -> "animal"
            }
            class Dog : Animal {
                func Bark() string -> "dog"
                override func Read() string -> "dog"
            }
            class Cat : Animal {
                override func Read() string -> "cat"
            }
            data class Holder(Callback (() -> void)) { }

            func Select(useUnknown bool, holder Holder) Animal {
                var x Animal = Dog{}
                var count = 0
                var replace = func() { x = Cat{} }
                if useUnknown {
                    replace = holder.Callback
                }
                if x is Dog {
                Again:
                    if count == 0 {
                        count++
                        replace()
                        goto Again
                    }
                    return x
                }
                return x
            }

            Select(false, Holder{Callback: func() { }}).Read()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("cat", result.Value);
    }

    [Fact]
    public void BackwardGoto_ConstructedGenericPropertyGuardRetainsNullableType()
    {
        var result = Evaluate("""
            class Box[T] {
                prop Value T { get; set; }
            }

            func Run() int32 {
                let box = Box[string?]{Value: "safe"}
                var count = 0
                if box.Value != nil {
                    if box.Value != nil {
                    Again:
                        let length = box.Value.Length
                        if count == 0 {
                            count++
                            box.Value = nil
                            goto Again
                        }
                        return length
                    }
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
    public void BackwardGoto_ConstructedGenericFieldGuardRetainsNullableType()
    {
        var result = Evaluate("""
            class Box[T] {
                var Value T
            }

            func Run() int32 {
                let box = Box[string?]{Value: "safe"}
                var count = 0
                if box.Value != nil {
                    if box.Value != nil {
                    Again:
                        let length = box.Value.Length
                        if count == 0 {
                            count++
                            box.Value = nil
                            goto Again
                        }
                        return length
                    }
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
    public void ForwardGoto_ThroughNonCompletingFinally_DoesNotActivateTargetEdges()
    {
        AssertRuns("""
            func Run(enter bool) int32 {
                var x string? = nil
                x = "safe"
                if enter {
                    try {
                        goto Enter
                    }
                    finally {
                        return 0
                    }
                }
                goto Use
            Enter:
                x = nil
                goto Use
            Use:
                return x.Length
            }

            Console.WriteLine(Run(false))
            """, "4");
    }

    [Fact]
    public void BackwardGoto_ThroughNonCompletingFinally_DoesNotActivateTargetEdges()
    {
        AssertRuns("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                goto After
            Enter:
                x = nil
                goto Use
            After:
                try {
                    goto Enter
                }
                finally {
                    return 4
                }
            Use:
                return x.Length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void BackwardGoto_GetterOnlyPropertyDoesNotValidateSubtypeSetter()
    {
        var result = Evaluate("""
            interface View {
                prop Value string { get; }
            }
            class Dog : View {
                prop Value string { get; set; }
            }
            class Cat : View {
                prop Value string -> "cat"
            }

            func Run() {
                var x View = Dog{}
                if x is Dog {
                Again:
                    x.Value = "changed"
                    x = Cat{}
                    goto Again
                }
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Value", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void BackwardGoto_SetterOnlyPropertyDoesNotValidateSubtypeGetter()
    {
        var result = Evaluate("""
            interface View {
                prop Value string { set; }
            }
            class Dog : View {
                prop Value string { get; set; }
            }
            class Cat : View {
                prop Value string { set; }
            }

            func Run() string {
                var x View = Dog{}
                if x is Dog {
                Again:
                    let value = x.Value
                    x = Cat{}
                    goto Again
                }
                return ""
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Value", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void BackwardGoto_GetterOnlyIndexerDoesNotValidateSubtypeSetter()
    {
        var result = Evaluate("""
            interface Values {
                prop this[index int32] string { get; }
            }
            class Dog : Values {
                prop this[index int32] string { get { return "dog" } set { } }
            }
            class Cat : Values {
                prop this[index int32] string -> "cat"
            }

            func Run() {
                var x Values = Dog{}
                if x is Dog {
                Again:
                    x[0] = "changed"
                    x = Cat{}
                    goto Again
                }
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0116");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_SetterOnlyIndexerDoesNotValidateSubtypeGetter()
    {
        var result = Evaluate("""
            interface Values {
                prop this[index int32] string { set; }
            }
            class Dog : Values {
                prop this[index int32] string { get { return "dog" } set { } }
            }
            class Cat : Values {
                prop this[index int32] string { set { } }
            }

            func Run() string {
                var x Values = Dog{}
                if x is Dog {
                Again:
                    let value = x[0]
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

    private static void AssertRuns(string source, params string[] expectedLines)
    {
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            string.Join(Environment.NewLine, expectedLines) + Environment.NewLine,
            result.Output.ReplaceLineEndings(Environment.NewLine));
    }
}

/// <summary>Imported call surface used to verify declared-receiver recovery does not rebind arguments.</summary>
public interface Issue4519ImportedCallReceiver
{
    /// <summary>Reads a deterministic value.</summary>
    bool TryRead(string key, out int value);

    /// <summary>Applies a callback to a deterministic value.</summary>
    int Apply(Func<int, int> selector);

    /// <summary>Describes the selected dispatch slot.</summary>
    string Describe();
}

/// <summary>First imported implementation used as the narrowed receiver.</summary>
public sealed class Issue4519ImportedCallDog : Issue4519ImportedCallReceiver
{
    /// <inheritdoc/>
    public bool TryRead(string key, out int value)
    {
        value = 11;
        return true;
    }

    /// <inheritdoc/>
    public int Apply(Func<int, int> selector) => selector(11);

    /// <summary>Public method that ordinary concrete lookup must retain.</summary>
    public string Describe() => "public";

    string Issue4519ImportedCallReceiver.Describe() => "explicit";
}

/// <summary>Second imported implementation reached by the backedge.</summary>
public sealed class Issue4519ImportedCallCat : Issue4519ImportedCallReceiver
{
    /// <inheritdoc/>
    public bool TryRead(string key, out int value)
    {
        value = 22;
        return true;
    }

    /// <inheritdoc/>
    public int Apply(Func<int, int> selector) => selector(22);

    /// <inheritdoc/>
    public string Describe() => "cat";
}

/// <summary>Imported base with ref-returning members used by declared-slot recovery tests.</summary>
public class Issue4519ImportedRefBase
{
    private int value;

    /// <summary>Initializes the stored value.</summary>
    protected Issue4519ImportedRefBase(int value)
    {
        this.value = value;
    }

    /// <summary>Gets a mutable reference.</summary>
    public ref int Value => ref value;

    /// <summary>Returns a mutable reference.</summary>
    public ref int Read() => ref value;
}

/// <summary>First imported ref-return implementation.</summary>
public sealed class Issue4519ImportedRefDog : Issue4519ImportedRefBase
{
    /// <summary>Initializes a dog value.</summary>
    public Issue4519ImportedRefDog()
        : base(11)
    {
    }
}

/// <summary>Second imported ref-return implementation.</summary>
public sealed class Issue4519ImportedRefCat : Issue4519ImportedRefBase
{
    /// <summary>Initializes a cat value.</summary>
    public Issue4519ImportedRefCat()
        : base(22)
    {
    }
}

/// <summary>Imported generic property used by declared-type diagnostic tests.</summary>
#nullable enable
public sealed class Issue4519ImportedGenericHolder<T>
{
    /// <summary>Initializes the holder.</summary>
    public Issue4519ImportedGenericHolder(T value)
    {
        Value = value;
    }

    /// <summary>Gets the value.</summary>
    public T Value { get; }
}
