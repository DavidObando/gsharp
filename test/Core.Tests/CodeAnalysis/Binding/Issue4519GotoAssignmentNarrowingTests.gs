// <copyright file="Issue4519GotoAssignmentNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #4519: a forward `goto` must not inherit assignment narrowing
/// performed only on the skipped fallthrough path.
open class Issue4519GotoAssignmentNarrowingTests {
    @Fact
    func ForwardGoto_BypassesAssignment_ReportsNullableReceiver() {
        let result = Evaluate(`func Run(cond bool) string {
    var x string? = nil
    if cond {
        goto SkipAssign
    }
    x = "hello"
SkipAssign:
    return x.Length.ToString()
}

Run(true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_GenericInterfaceMethodDoesNotRequireNarrowedType() {
        let result = Evaluate(`interface Mapper {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("safe", result.Value)
    }

    @Fact
    func ForwardGoto_NestedDeferRunsBeforeOuterFinally() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func ForwardGoto_OuterFinallyRunsAfterNestedDefer() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func DirectFallthroughAssignment_RemainsNarrowed() {
        AssertRuns(`import System

func Run() {
    var x string? = nil
    x = "hello"
    Console.WriteLine(x.Length)
}

Run()`, "5")
    }

    @Fact
    func BackwardGoto_AfterDominatingAssignment_RemainsNarrowed() {
        AssertRuns(`import System

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

Run()`, "2", "2")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsNullableReceiver() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsNullableMethodReceiver() {
        let result = Evaluate(`func Run() string {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("ToString", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsNonNullConversion() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsIndexReceiver() {
        let result = Evaluate(`func Run() char {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0116")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsIndirectInvocation() {
        let result = Evaluate(`import System

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("f", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsParenthesizedIndirectInvocation() {
        let result = Evaluate(`import System

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("(f)", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsMemberWriteReceiver() {
        let result = Evaluate(`import System.Text

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsParenthesizedMemberWriteReceiver() {
        let result = Evaluate(`import System.Text

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsLockSubject() {
        let result = Evaluate(`class Gate {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterNullableAssignment_ReportsDeconstructionSource() {
        let result = Evaluate(`data class Pair(A int32, B int32) {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_AfterTypeTestNarrowing_ReportsMemberAccess() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("Bark", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_IncompatibleTypeTestNarrowing_ReportsMemberAccess() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("Bark", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InheritedMemberDoesNotRequireNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func BackwardGoto_NullableUserMethodReceiverStillRequiresNonNull() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("Name", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InheritedPropertyDoesNotRequireNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func BackwardGoto_InheritedFieldDoesNotRequireNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func BackwardGoto_InheritedImportedCallDoesNotRequireNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func BackwardGoto_InheritedPropertyWriteDoesNotRequireNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("updated", result.Value)
    }

    @Fact
    func BackwardGoto_OverriddenPropertyWriteUsesDeclaredSlot() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("updated", result.Value)
    }

    @Fact
    func BackwardGoto_ConstructedInterfacePropertyWriteUsesDeclaredSlot() {
        let result = Evaluate(`interface IBox[T] {
    prop Value T { get; set; }
}
open class FirstBox : IBox[string] {
    var Stored string = ""
    public open prop Value string {
        get { return Stored }
        set { Stored = value }
    }
}
class SecondBox : IBox[string] {
    var Stored string = ""
    public prop Value string {
        get { return Stored }
        set { Stored = value }
    }
}

func Run() string {
    var box IBox[string] = FirstBox{}
    var count = 0
    if box is FirstBox {
    Again:
        box.Value = "updated"
        if count == 0 {
            count++
            box = SecondBox{}
            goto Again
        }
        return box.Value
    }
    return ""
}

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("updated", result.Value)
    }

    @Fact
    func BackwardGoto_InheritedFieldWriteDoesNotRequireNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("updated", result.Value)
    }

    @Fact
    func BackwardGoto_SubtypeOnlyPropertyWriteStillRequiresNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Sound", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_SubtypeOnlyFieldWriteStillRequiresNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Sound", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_SubtypeOnlyPropertyStillRequiresNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Sound", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_SubtypeOnlyFieldStillRequiresNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Sound", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_HiddenPropertyKeepsSelectedSubtypeSlot() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "dog")
    }

    @Fact
    func BackwardGoto_HiddenFieldKeepsSelectedSubtypeSlot() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "dog")
    }

    @Fact
    func BackwardGoto_HiddenPropertyWriteKeepsSelectedSubtypeSlot() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("selected", result.Value)
    }

    @Fact
    func BackwardGoto_HiddenFieldWriteKeepsSelectedSubtypeSlot() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("selected", result.Value)
    }

    @Fact
    func BackwardGoto_ParenthesizedOverrideDoesNotRequireNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func BackwardGoto_InterfaceMemberDoesNotRequireNarrowedType() {
        let result = Evaluate(`interface Named {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func BackwardGoto_SubtypeOnlyOverloadStillRequiresNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("Describe", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InheritedIndexerDoesNotRequireNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func BackwardGoto_InterfaceIndexerDoesNotRequireNarrowedType() {
        let result = Evaluate(`interface Values {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func BackwardGoto_ConstructedGenericInterfaceIndexerDoesNotRequireNarrowedType() {
        let result = Evaluate(`interface Values[T] {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("cat", result.Value)
    }

    @Fact
    func BackwardGoto_NullableInterfaceIndexerStillRequiresNonNullReceiver() {
        let result = Evaluate(`interface Values {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0116")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_SubtypeOnlyIndexerOverloadStillRequiresNarrowedType() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0116")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_TracksSelectedInheritedIndexerOverload() {
        let result = Evaluate(`interface IntValues {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0116")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_TracksSelectedInheritedIndexerWriteOverload() {
        let result = Evaluate(`interface IntValues {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0116")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_ExistingEdgeReceivesLaterMemberAccess() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_TypeTestNarrowingAtForSource_ReportsConversion() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_TypeTestNarrowingThroughUpcast_ReportsConversion() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_TypeTestNarrowingThroughNullableUpcast_ReportsConversion() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_TypeTestNarrowingThroughNullSafeCall_ReportsConversion() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_StackedLabeledGuardReestablishesNarrowing() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "0")
    }

    @Fact
    func BackwardGoto_PoppedNestedGuardGenerationDoesNotHideOuterProof() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedMemberPath() {
        let result = Evaluate(`data class Box(Value string?) {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedMemberPathAtLockBoundary() {
        let result = Evaluate(`class Gate {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("box.Gate", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedMemberPathConversion() {
        let result = Evaluate(`data class Box(Value string?) {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("box.Value", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Contains("'string?'", diagnostic.Message, StringComparison.Ordinal)
        Assert.DoesNotContain("'Box'", diagnostic.Message, StringComparison.Ordinal)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_ImportedMemberPathConversionRetainsDeclaredNullability() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

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

Run()`, []string{typeof(Issue4519ImportedGenericHolder[_]).Assembly.Location})
        let diagnostics = result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0155").ToArray()
        Assert.Equal(2, diagnostics.Length)
        Assert.All(
            diagnostics,
            (diagnostic Diagnostic) -> Assert.Contains("'string?'", diagnostic.Message, StringComparison.Ordinal)
        )
        Assert.Contains(
            diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Location.Text!!.ToString(diagnostic.Location.Span) == "box.Value"
        )
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedMemberPathIndex() {
        let result = Evaluate(`data class Box(Text string?) {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0116")
        Assert.Equal("Text", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Contains("'string?'", diagnostic.Message, StringComparison.Ordinal)
        Assert.DoesNotContain("'Box'", diagnostic.Message, StringComparison.Ordinal)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedMemberPathWriteReceiver() {
        let result = Evaluate(`class Child {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Name", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_IncompatibleSubtypeDoesNotPreserveTargetNarrowing() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("Bark()", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_JoinsFallthroughAndIncomingToCommonSupertype() {
        let result = Evaluate(`open class Animal {
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

Run(true)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("animal", result.Value)
    }

    @Fact
    func ForwardGoto_JoinsSiblingAssignmentsToDeclaredSupertype() {
        let result = Evaluate(`open class Animal {
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

Run(true)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("animal", result.Value)
    }

    @Fact
    func ForwardGoto_DoesNotJoinNumericWideningWithoutConversion() {
        let result = Evaluate(`func Run() int64 {
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

Run()`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert type 'object' to 'int64'", StringComparison.Ordinal)
        )
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_DoesNotAcceptNumericWideningWithoutConversion() {
        let result = Evaluate(`func Run() int64 {
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

Run()`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert type 'object' to 'int64'", StringComparison.Ordinal)
        )
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_JoinDoesNotOverwriteShadowedOuterFrame() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Sound", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_BypassesConditionFrame_ReportsMemberAccess() {
        let result = Evaluate(`func Run() int32 {
    var x string? = nil
    goto Use
    if x != nil {
    Use:
        return x.Length
    }
    return 0
}

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyEstablishesOnlyReachableNarrowing() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func ForwardGoto_FinallyNarrowingDoesNotOverrideReachableFallthrough() {
        let result = Evaluate(`func Run(jump bool) int32 {
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

Run(false)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyNarrowingIsInvalidatedByUnsafeBackedge() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyIgnoresUninvokedFunctionBodyMutation() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func ForwardGoto_FinallyIncludesImmediatelyInvokedFunctionBodyMutation() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyIncludesCallableArgumentBodyMutation() {
        let result = Evaluate(`func Invoke(action (() -> void)) {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyIncludesImportedCallableArgumentBodyMutation() {
        let result = Evaluate(`import System

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyTreatsMixedExternalAndUnknownCallableAsUnsafe() {
        let result = Evaluate(`data class Holder(Callback (() -> void)) {
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

Run(func() { }, true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyIncludesCapturedGenericLocalFunctionMutation() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyIncludesInvokedStoredFunctionBodyMutation() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyIncludesInvokedCallableAliasMutation() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyIncludesAliasDeclaredOutsideFinally() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyIncludesConditionalCallableTarget() {
        let result = Evaluate(`func Run(useNoop bool) int32 {
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

Run(false)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyUsesLastUnconditionalCallableTarget() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func ForwardGoto_FinallyPreservesCallableTargetAcrossZeroIterationLoop() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyIncludesLoopCarriedCallableTarget() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyReanalyzesCallableWithUpdatedAliasState() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyCatchIncludesIntermediateCallableTarget() {
        let result = Evaluate(`import System

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyUsesUnconditionalCallableTargetAfterLoop() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func ForwardGoto_FinallyPreservesCallableTargetAcrossUnconditionalGoto() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyPreservesCallableTargetAcrossSwitchArms() {
        let result = Evaluate(`func Run(value int32) int32 {
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

Run(0)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyPreservesCallableTargetAcrossCatchBranches() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_LeavingDeferScopeAppliesCleanupMutation() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func Fallthrough_DeferAliasCleanupInvalidatesNarrowing() {
        let result = Evaluate(`func Run() int32 {
    var x string? = nil
    x = "safe"
    let clear = func() { x = nil }
    {
        defer clear()
    }
    return x.Length
}

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func CapturedFunctionCall_PreservesReadonlyLocalNarrowing() {
        let result = Evaluate(`func Run(present bool) int32 {
    let text string? = if present { "safe" } else { nil }
    if text == nil {
        return 0
    }
    var calls = 0
    let count = func() { calls++ }
    count()
    return text.Length
}

Run(true)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func ForwardGoto_FinallyPreservesExternalCallableAliasesAcrossJoin() {
        let result = Evaluate(`func Run(callback (() -> void), choose bool) int32 {
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

Run(func() { }, true)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func ForwardGoto_DeferUsesCallableAliasStateFromEachEdge() {
        let result = Evaluate(`func Noop() {
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

Run(true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyPreservesAssignedExternalCallableAlias() {
        AssertRuns(`import System

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

Console.WriteLine(Run(Noop))`, "4")
    }

    @Fact
    func ForwardGoto_FinallyPreservesExternalCallableAliasAssignedInNestedBlock() {
        AssertRuns(`import System

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

Console.WriteLine(Run(Noop))`, "4")
    }

    @Fact
    func ForwardGoto_FinallyIncludesWritableRefMutation() {
        let result = Evaluate(`func Clear(out value string?) {
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

Run()`)
        let diagnostic = result.Diagnostics.Single((d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyReadonlyRefPreservesUnrelatedNarrowing() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func BackwardGoto_FinallyIncludesMemberPathMutation() {
        let result = Evaluate(`class Box {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_ConstrainedCallArgumentTracksNarrowing() {
        let result = Evaluate(`import System

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

Run(1)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_IntoNestedScopePreservesOuterNarrowingFrame() {
        AssertRuns(`import System

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

Run()`, "4", "4")
    }

    @Fact
    func UnreachableForwardGoto_DoesNotInvalidateReachableNarrowing() {
        AssertRuns(`import System

func Run() int32 {
    var x string? = nil
    x = "safe"
    goto Done
    x = nil
    goto Done
Done:
    return x.Length
}

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func UnreachableBackwardGoto_DoesNotInvalidateReachableNarrowing() {
        AssertRuns(`import System

func Run() int32 {
    var x string? = nil
    x = "safe"
Again:
    let length = x.Length
    return length
    x = nil
    goto Again
}

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func ForwardGoto_EnteringNestedBlockPropagatesReachability() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_EnteringLoopBodyPropagatesReachability() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_EnteringInfiniteLoopBreakPropagatesReachability() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_EnteringFiniteLoopContinuePropagatesReachability() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_EnteringLoweredLoopContinuePropagatesReachability() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_EnteringSwitchBreakPropagatesReachability() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_EnteringSwitchFallthroughPropagatesReachability() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_EnteringTryPropagatesReachabilityIntoFinally() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_EnteringTryPropagatesReachabilityIntoCatch() {
        let result = Evaluate(`import System

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func NestedFunctionLabelDoesNotMakeOuterFinallyReachable() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedCallableMemberPath() {
        let result = Evaluate(`data class Holder(Callback (() -> int32)?) {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("Invoke", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedImplicitFieldCallee() {
        let result = Evaluate(`func One() int32 { return 1 }

class Holder {
    var Callback (() -> int32)? = One

    func Run() int32 {
        var count = 0
        if Callback != nil {
        Again:
            let value = Callback()
            if count == 0 {
                count++
                Callback = nil
                goto Again
            }
        }
        return 0
    }
}

Holder{}.Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0503")
        Assert.Equal("Callback", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedImplicitFieldCalleeInParentheses() {
        let result = Evaluate(`func One() int32 { return 1 }

class Holder {
    var Callback (() -> int32)? = One

    func Run() int32 {
        var count = 0
        if Callback != nil {
        Again:
            let value = (Callback)()
            if count == 0 {
                count++
                Callback = nil
                goto Again
            }
        }
        return 0
    }
}

Holder{}.Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0503")
        Assert.Equal("(Callback)", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedImplicitFieldCalleeClearedByCall() {
        let result = Evaluate(`func One() int32 { return 1 }

class Holder {
    var Callback (() -> int32)? = One

    func Reset() {
        Callback = nil
    }

    func Run() int32 {
        var count = 0
        if Callback != nil {
        Again:
            let value = Callback()
            if count == 0 {
                count++
                Reset()
                goto Again
            }
        }
        return 0
    }
}

Holder{}.Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0503")
        Assert.Equal("Callback", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidatesNarrowedImplicitPropertyCallee() {
        let result = Evaluate(`func One() int32 { return 1 }

class Holder {
    prop Callback (() -> int32)? { get; set; } = One

    func Reset() {
        Callback = nil
    }

    func Run() int32 {
        var count = 0
        if Callback != nil {
        Again:
            let value = Callback()
            if count == 0 {
                count++
                Callback = nil
                goto Again
            }
        }
        return 0
    }
}

Holder{}.Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0503")
        Assert.Equal("Callback", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func LocalLambdaCall_DoesNotDropUnrelatedLocalNarrowing() {
        let result = Evaluate(`func Run(a string?, b string?) int32 {
    var left = a
    var right = b
    if left == nil || right == nil {
        return 0
    }
    let same = func(x string, y string) bool { return x == y }
    if same(left, right) { return 1 }

    return left.Length + right.Length
}

Run("a,b", "c")`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func LocalLambdaCall_InPatternGuard_DoesNotDropUnrelatedLocalNarrowing() {
        let result = Evaluate(`func Run(a string?, b string?) int32 {
    var left = a
    var right = b
    if left == nil || right == nil {
        return 0
    }
    let same = func(x string, y string) bool { return x == y }
    if left is string ls && right is string rs && same(ls, rs) { return 1 }

    return left.Length + right.Length
}

Run("a,b", "c")`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func LocalLambdaCall_StillDropsNarrowingOfLocalTheLambdaAssigns() {
        let result = Evaluate(`func Run(a string?) int32 {
    var text = a
    let clear = func() { text = nil }
    if text != nil {
        clear()
        return text.Length
    }
    return 0
}

Run("a")`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func UnknownCallableCall_StillDropsNarrowingOfByReferenceParameter() {
        let result = Evaluate(`class Box {
    var Action (() -> void)? = nil
}

func Run(ref text string?, box Box) int32 {
    if text != nil {
        box.Action!!()
        return text.Length
    }
    return 0
}

var value string? = "a"
let box = Box{}
box.Action = func() { value = nil }
Run(ref value, box)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func OutVariableInOrGuard_EarlyExitKeepsNarrowing() {
        let result = Evaluate(`func TryGet(out value string?) bool {
    value = "abc"
    return true
}

func Run() int32 {
    if !TryGet(out var v) || v == nil {
        return 0
    }
    return v.Length
}

Run()`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func OutArgumentInOrGuard_EarlyExitKeepsNarrowing() {
        let result = Evaluate(`func TryGet(out value string?) bool {
    value = "abc"
    return true
}

func Run() int32 {
    var v string? = nil
    if !TryGet(out v) || v == nil {
        return 0
    }
    return v.Length
}

Run()`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func AddressOfRefArgument_WithUnknownCallableArgument_KeepsOtherLocalNarrowing() {
        let result = Evaluate(`func Wrap(project (string) -> string?, ref value string) bool {
    value = value + "x"
    return true
}

func Id(f (string) -> string?) (string) -> string? {
    return f
}

func Run(source (string) -> string?, a string, b string, flagA bool, flagB bool) string? {
    let project = Id(source)
    var pa string? = project(a)
    var pb string? = project(b)
    if pa == nil || pb == nil {
        return nil
    }
    if flagA && !Wrap(project, &pa) {
        return nil
    }
    if flagB && !Wrap(project, &pb) {
        return nil
    }
    return pa + pb
}

Run(func(s string) string? { return s }, "a", "b", true, true)`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UnknownCallableCall_StillDropsNarrowingOfLocalWrittenThroughClosureReferenceArgument() {
        let result = Evaluate(`func Clear(ref value string?) {
    value = nil
}

func Run(a string?) int32 {
    var text = a
    let reset = func() { Clear(&text) }
    if text != nil {
        reset()
        return text.Length
    }
    return 0
}

Run("a")`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_ConditionInvokedClosureChangesExternalCallableAlias() {
        let result = Evaluate(`func Run(callback (() -> void)) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = callback
    if func() bool { action = clear; return true }() {
        try {
            goto Done
        }
        finally {
            action()
        }
    }
Done:
    return text.Length
}

Run(func() { })`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_SwitchDiscriminantClosureChangesExternalCallableAlias() {
        let result = Evaluate(`func Run(callback (() -> void), choose int32) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = callback
    switch func() int32 { action = clear; return 1 }() {
        case 1 {
            try {
                goto Done
            }
            finally {
                action()
            }
        }
        default {
        }
    }
Done:
    return text.Length
}

Run(func() { }, 1)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_LoopHeaderClosureChangesExternalCallableAlias() {
        let result = Evaluate(`func Run(callback (() -> void)) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = callback
    for var i = 0; func() bool { action = clear; return i < 2 }(); i++ {
        try {
            goto Done
        }
        finally {
            action()
        }
    }
Done:
    return text.Length
}

Run(func() { })`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_MemberNotNullAfterLabelReestablishesNarrowing() {
        AssertRuns(`import System
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

Console.WriteLine(Box{}.Run())`, "4")
    }

    @Fact
    func UnrelatedEarlierGotoDoesNotLinkLaterBackwardLabel() {
        AssertRuns(`import System

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
Console.WriteLine(Run(false))`, "4", "4")
    }

    @Fact
    func ForwardGoto_BypassesLabeledSwitchGuard_ReportsMemberAccess() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("Bark()", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_IntoNestedLabeledElseDoesNotLiftOuterGuard() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_InvalidationPropagatesThroughForwardLabel() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_LateForwardLabelDependencyUpdatesExistingEdge() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_RepeatedGuardReestablishesNarrowing() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4", "1")
    }

    @Fact
    func BackwardGoto_EarlyExitGuardReestablishesNarrowing() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "1")
    }

    @Fact
    func BackwardGoto_AfterPostLabelNonNullAssignment_RemainsNarrowed() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func BackwardGoto_PostLabelAssignmentWithoutTargetGeneration_RemainsNarrowed() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func BackwardGoto_ThroughFinallyMutation_ReportsNullableReceiver() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_ThroughFinallyIndirectAliasMutation_ReportsNullableReceiver() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_ThroughNonNullFinallyAssignment_RemainsNarrowed() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func BackwardGoto_ThroughNonCompletingFinally_DoesNotInvalidate() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "0")
    }

    @Fact
    func NestedFunction_BackwardGotoUsesIndependentJoinState() {
        let result = Evaluate(`func Outer() int32 {
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

Outer()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func MultipleForwardBranches_BypassingDifferentAssignments_RejectBothReads() {
        const source = `func Run(first bool, second bool) int32 {
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

Run(true, true)`
        let result = Evaluate(source)
        let nullableReads = result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0158").ToArray()
        Assert.Equal(2, nullableReads.Length)
        Assert.All(nullableReads, (d Diagnostic) -> Assert.Equal("Length", d.Location.Text!!.ToString(d.Location.Span)))
        Assert.Equal(
            []int32{
                source.IndexOf("x.Length", StringComparison.Ordinal) + "x.".Length,
                source.IndexOf("y.Length", StringComparison.Ordinal) + "y.".Length
            },
            nullableReads.Select((d Diagnostic) -> d.Location.Span.Start).OrderBy((position int32) -> position)
        )
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func MultipleGotosToSameLabel_IntersectTheirNarrowingStates() {
        let result = Evaluate(`func Run(first bool, second bool) int32 {
    var x string? = nil
    if first { goto Done }
    x = "safe"
    if second { goto Done }
Done:
    return x.Length
}

Run(true, false)`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_IntoNestedGuardsRemovesAllStaleProofs() {
        let result = Evaluate(`open class Animal {
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

Run(true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Name", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func AssignmentBeforeEveryForwardJump_RemainsNarrowedAtLabel() {
        AssertRuns(`import System

func Run(jump bool) {
    var x string? = nil
    x = "safe"
    if jump { goto Done }
    x = "also safe"
Done:
    Console.WriteLine(x.Length)
}

Run(true)
Run(false)`, "4", "9")
    }

    @Fact
    func ForwardGoto_BypassesConditionalValueAssignment_ReportsNullableReceiver() {
        let result = Evaluate(`func Run(jump bool, choose bool) int32 {
    var x string? = nil
    if jump { goto Done }
    x = if choose { "a" } else { "bb" }
Done:
    return x.Length
}

Run(true, false)`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGotoFromNestedScope_InvalidatesOnlyBypassedLocal() {
        let result = Evaluate(`func Run(jump bool) int32 {
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

Run(true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        let text = diagnostic.Location.Text!!.ToString()
        Assert.Equal(
            text.IndexOf("skipped.Length", StringComparison.Ordinal) + "skipped.".Length,
            diagnostic.Location.Span.Start
        )
    }

    @Fact
    func AssignmentAtTargetAfterOtherLabels_RemainsNarrowed() {
        AssertRuns(`import System

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

Run(true)`, "assign", "4")
    }

    @Fact
    func NestedFunction_UsesIndependentGotoJoinState() {
        let result = Evaluate(`func Outer() int32 {
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

Outer()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func GotoLeavingTry_AppliesFinallyMutationBeforeLabelJoin() {
        let result = Evaluate(`func Run(jump bool) int32 {
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

Run(true)`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func GotoLeavingTry_PreservesNarrowingWhenFinallyAssignsNonNull() {
        AssertRuns(`import System

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

Run(true)`, "5")
    }

    @Fact
    func GotoLeavingTry_UsesNarrowingEstablishedByFinally() {
        AssertRuns(`import System

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

Run(true)`, "5")
    }

    @Fact
    func GotoLeavingTry_AndFallthroughUseNarrowingEstablishedByFinally() {
        AssertRuns(`import System

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
Run(true)`, "5", "5")
    }

    @Fact
    func ConditionalFinallyAssignment_DoesNotEstablishNarrowing() {
        let result = Evaluate(`func Run(jump bool, assign bool) int32 {
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

Run(true, false)`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    @Fact
    func LocalGotoInFinally_DoesNotDropNullableExitPath() {
        let result = Evaluate(`func Run(jump bool, skip bool) int32 {
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

Run(true, true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func LocalGotoInFinally_RemainsInMultipleGotoJoin() {
        let result = Evaluate(`func Run(throughFinally bool, direct bool, skip bool) int32 {
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

Run(true, false, true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func NestedFinally_EstablishesNarrowingForOuterGoto() {
        AssertRuns(`import System

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

Run(true)`, "4")
    }

    @Fact
    func NonCompletingFinally_DoesNotInvalidateFallthroughNarrowing() {
        AssertRuns(`import System

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

Console.WriteLine(Run(false))`, "4")
    }

    @Fact
    func LocalGotoInNonCompletingFinally_DoesNotInvalidateFallthroughNarrowing() {
        AssertRuns(`import System

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

Console.WriteLine(Run(false))`, "4")
    }

    @Fact
    func UnreachableBackedgeAfterInfiniteLoopDoesNotInvalidateNarrowing() {
        let result = Evaluate(`func Run() int32 {
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

0`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UnreachableBackedgeAfterExhaustiveSwitchDoesNotInvalidateNarrowing() {
        let result = Evaluate(`func Run(value object) int32 {
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

0`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BackwardGoto_MemberPathRecoversDeclaredBaseMethod() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("animal", result.Value)
    }

    @Fact
    func BackwardGoto_DoesNotReuseSiblingMemberPathProof() {
        let result = Evaluate(`import System

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

Console.WriteLine(Run())`)
        Assert.True(
            result.Diagnostics.IsEmpty,
            string.Join(
                Environment.NewLine,
                result.Diagnostics.Select(
                    (
                        diagnostic Diagnostic
                    ) -> "${diagnostic.Id} ${diagnostic.Location.Text!!.ToString(diagnostic.Location.Span)}: ${diagnostic.Message}"
                )
            )
        )
        Assert.Equal("4${Environment.NewLine}", result.Output.ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func NestedFunctionBetweenFinallyAndTarget_DoesNotLoseOuterFinallyEffects() {
        let result = Evaluate(`func Run(jump bool) int32 {
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

Run(true)`)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_OverriddenIndexerWriteUsesDeclaredSlot() {
        let result = Evaluate(`open class Animal {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func LabeledTryFinallyPropagatesNonNullAssignment() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func BackwardConditionalGotoDoesNotKeepOldCallableTargetPending() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func BackwardGoto_ChangedCallableTargetAlreadyInvalidatesCapturedRoot() {
        let result = Evaluate(`data class Holder(Callback (() -> void)) {
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

Run(func() { })`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func UninvokedNestedFunction_DoesNotLeakCallableAliasState() {
        let result = Evaluate(`func Noop() {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardReachabilityActivatesOutgoingGotoFromEarlierLabel() {
        let result = Evaluate(`func Run() int32 {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func NestedFunctionActivatesDeferredReachableGotoEdges() {
        let result = Evaluate(`let run = func() int32 {
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

run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func CallableArgumentWithKnownAndUnknownTargetsRemainsUnsafe() {
        let result = Evaluate(`data class Holder(Callback (() -> void)) {
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

Run(true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func CallableArgumentWithExternalAndUnknownTargetsRemainsUnsafe() {
        let result = Evaluate(`data class Holder(Callback (() -> void)) {
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

Run(func() { }, true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_LabelJoinIntersectsExternalCallableAliases() {
        let result = Evaluate(`func Noop() {
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

Run(true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_LabelJoinIncludesCleanupCallableReassignment() {
        let result = Evaluate(`func Noop() {
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

Run(true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func LabeledDirectExternalCallableAssignmentPreservesLocalNarrowing() {
        AssertRuns(`import System

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

Console.WriteLine(Run(func() { }))`, "4")
    }

    @Fact
    func ForwardGoto_WeakeningInnerProofRemovesShadowedOuterProof() {
        let result = Evaluate(`open class Animal {
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

Run(true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.Equal("Bark()", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func RepresentationPreservingJoinRejectsPlatformCheckedConversion() {
        Assert.False(
            Conversion.IsRepresentationPreservingImplicit(PlatformTypeSymbol.Get(TypeSymbol.String), TypeSymbol.String)
        )
    }

    @Fact
    func ForwardGoto_FinallyUsesCallableStateAtEntry() {
        let result = Evaluate(`func Run(callback (() -> void)) int32 {
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

Run(func() { })`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyConditionalOutInvalidatesBothPossibleRoots() {
        let result = Evaluate(`func Clear(out value string?) {
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

Run(true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyPreservesMutableAliasInitializedFromReadonlyCallback() {
        AssertRuns(`import System

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

Console.WriteLine(Run(func() { }))`, "4")
    }

    @Fact
    func ForwardGoto_FinallyExternalCallbackInvalidatesWritableRefParameter() {
        let result = Evaluate(`func Run(ref text string?, callback (() -> void)) int32 {
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

Outer()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallyBranchJoinUsesCallableStateBeforeIf() {
        let result = Evaluate(`func Run(callback (() -> void), keepClear bool) int32 {
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

Run(func() { }, true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_ElseCleanupDoesNotInheritThenOnlyExternalAlias() {
        let result = Evaluate(`func Run(callback (() -> void), useCallback bool) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = clear
    if useCallback {
        action = callback
    }
    else {
        try {
            goto Done
        }
        finally {
            action()
        }
    }
Done:
    return text.Length
}

Run(func() { }, false)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_LoopCleanupUsesLoopCarriedCallableAlias() {
        let result = Evaluate(`func Run(callback (() -> void)) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = callback
    var iteration = 0
    for _ in []int32{0, 1} {
        try {
            if iteration > 0 {
                goto Done
            }
        }
        finally {
            action()
        }
        action = clear
        iteration++
    }
Done:
    return text.Length
}

Run(func() { })`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_SwitchCleanupDoesNotInheritSiblingExternalAlias() {
        let result = Evaluate(`func Run(callback (() -> void), value int32) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = clear
    switch value {
        case 1 {
            action = callback
        }
        default {
            try {
                goto Done
            }
            finally {
                action()
            }
        }
    }
Done:
    return text.Length
}

Run(func() { }, 0)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_CatchCleanupDoesNotInheritSiblingExternalAlias() {
        let result = Evaluate(`import System

func Run(callback (() -> void)) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = clear
    try {
        throw Exception()
    }
    catch (ArgumentException) {
        action = callback
    }
    catch {
        try {
            goto Done
        }
        finally {
            action()
        }
    }
Done:
    return text.Length
}

Run(func() { })`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_SwitchJoinIgnoresExitingCallableArm() {
        AssertRuns(`import System

func Run(callback (() -> void), value int32) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = callback
    switch value {
        case 1 {
            action = clear
            return 0
        }
        default {
        }
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

Console.WriteLine(Run(func() { }, 0))`, "4")
    }

    @Fact
    func ForwardGoto_IfJoinIgnoresExitingCallableArm() {
        AssertRuns(`import System

func Run(callback (() -> void), exitEarly bool) int32 {
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = callback
    if exitEarly {
        action = clear
        return 0
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

Console.WriteLine(Run(func() { }, false))`, "4")
    }

    @Fact
    func ForwardGoto_TryJoinIgnoresExitingCallableCatch() {
        AssertRuns(`import System

func Run(callback (() -> void), fail bool) int32 {
    // ADR-0208 R15: a constructor call is a call, so build the exception before the fact is established.
    let failure = Exception()
    var text string? = nil
    text = "safe"
    let clear = func() { text = nil }
    var action = callback
    try {
        if fail {
            throw failure
        }
    }
    catch {
        action = clear
        return 0
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

Console.WriteLine(Run(func() { }, false))`, "4")
    }

    @Fact
    func TryFinallyExceptionalCallableStateInvalidatesNarrowing() {
        let result = Evaluate(`import System

func Run(callback (() -> void)) int32 {
    var text string? = nil
    let mutate = func() { text = nil }
    var action = mutate
    try {
        throw Exception()
        action = callback
    }
    catch {
    }
    finally {
        text = "safe"
        action()
    }
    return text.Length
}

Run(func() { })`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func TryFinallyFallthroughIgnoresReturningCallableState() {
        AssertRuns(`import System

func Run(callback (() -> void), exitEarly bool) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = callback
    try {
        if exitEarly {
            action = clear
            return 0
        }
    }
    finally {
        text = "safe"
        action()
    }
    return text.Length
}

Console.WriteLine(Run(func() { }, false))`, "4")
    }

    @Fact
    func TryFinallyFallthroughUsesCallableStateAtEachStatement() {
        AssertRuns(`import System

func Run(callback (() -> void)) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = callback
    try {
    }
    finally {
        {
            text = "safe"
            action()
            action = clear
        }
    }
    return text.Length
}

Console.WriteLine(Run(func() { }))`, "4")
    }

    @Fact
    func SwitchBreakArm_LocalCallableAliasDefeatsExternalFinallyNarrowing() {
        let result = Evaluate(`func Run(callback (() -> void), choose int32) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = callback
    switch choose {
        case 0 {
            action = clear
            break
        }
        default {
            action = callback
        }
    }
    try {
    }
    finally {
        text = "safe"
        action()
    }
    return text.Length
}

Run(func() { }, 0)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func LoopAssignedExternalCallable_LocalAliasDefeatsFinallyNarrowing() {
        let result = Evaluate(`func Run(callback (() -> void), n int32) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = clear
    var i = 0
    for i < n {
        i++
        action = callback
    }
    try {
    }
    finally {
        text = "safe"
        action()
    }
    return text.Length
}

Run(func() { }, 3)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func LoopSkippedExternalAssignment_LocalCallableAliasIsNotExternal() {
        let result = Evaluate(`func Run(callback (() -> void), n int32) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = clear
    var i = 0
    for i < n { i++
        action = callback }
    text = "safe"
    action()
    return text.Length
}

Run(func() { }, 3)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func LoopContinueBeforeExternalAssignment_LocalAliasDefeatsFinallyNarrowing() {
        let result = Evaluate(`func Run(callback (() -> void), n int32) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = clear
    for var i = 0; i < n; i++ {
        if i == 1 { continue }
        action = callback
    }
    try {
    }
    finally {
        text = "safe"
        action()
    }
    return text.Length
}

Run(func() { }, 3)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func LoopBreakBeforeExternalAssignment_LocalAliasDefeatsFinallyNarrowing() {
        let result = Evaluate(`func Run(callback (() -> void), n int32) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = clear
    for var i = 0; i < n; i++ {
        if i == 1 { break }
        action = callback
    }
    try {
    }
    finally {
        text = "safe"
        action()
    }
    return text.Length
}

Run(func() { }, 3)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func SwitchBreakInTryBody_LocalCallableAliasDefeatsExternalFinallyNarrowing() {
        let result = Evaluate(`func Run(callback (() -> void), choose int32) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = callback
    switch choose {
        case 0 {
            try {
                action = clear
                break
            }
            finally {
            }
        }
        default {
            action = callback
        }
    }
    try {
    }
    finally {
        text = "safe"
        action()
    }
    return text.Length
}

Run(func() { }, 0)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func SwitchBreakInCatchBody_LocalCallableAliasDefeatsExternalFinallyNarrowing() {
        let result = Evaluate(`func Run(callback (() -> void), choose int32) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = callback
    switch choose {
        case 0 {
            try {
            }
            catch {
                action = clear
                break
            }
        }
        default {
            action = callback
        }
    }
    try {
    }
    finally {
        text = "safe"
        action()
    }
    return text.Length
}

Run(func() { }, 0)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func NestedSwitchBreakArm_LocalCallableAliasDefeatsExternalFinallyNarrowing() {
        let result = Evaluate(`func Run(callback (() -> void), choose int32, flag bool) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = callback
    if flag {
        switch choose {
            case 0 {
                action = clear
                break
            }
            default {
                action = callback
            }
        }
    }
    try {
    }
    finally {
        text = "safe"
        action()
    }
    return text.Length
}

Run(func() { }, 0, true)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_NonCompletingInfiniteFinallyDoesNotActivateEdge() {
        AssertRuns(`import System

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

Console.WriteLine(Run(false))`, "4")
    }

    @Fact
    func ImportedGenericInterfaceMethod_RecoversDeclaredSlotUnderMetadataLoadContext() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

func Run() int32 {
    var x Issue4519ImportedGenericMapper = Issue4519ImportedGenericMapperDog()
    var count = 0
    if x is Issue4519ImportedGenericMapperDog {
    Again:
        let mapped = x.Map[int32](5, func(v int32) int32 { return v + 1 })
        if count == 0 {
            count++
            x = Issue4519ImportedGenericMapperCat()
            goto Again
        }
        return mapped
    }
    return 0
}

Run()`, []string{typeof(Issue4519ImportedGenericMapper).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ImportedCallRecovery_DoesNotRebindInlineOutVariable() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

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

Run()`, []string{typeof(Issue4519ImportedCallReceiver).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Equal(22, result.Value)
    }

    @Fact
    func ImportedCallRecovery_DoesNotRebindCapturedLambda() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

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

Run()`, []string{typeof(Issue4519ImportedCallReceiver).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Equal(25, result.Value)
    }

    @Fact
    func BackwardGoto_PublicPropertyDoesNotAliasExplicitInterfaceProperty() {
        let result = Evaluate(`interface View {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("public", result.Value)
    }

    @Fact
    func BackwardGoto_PublicPropertyDoesNotAliasInheritedExplicitInterfaceProperty() {
        let result = Evaluate(`interface View {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("public", result.Value)
    }

    @Fact
    func BackwardGoto_PublicIndexerDoesNotAliasInheritedExplicitInterfaceIndexer() {
        let result = Evaluate(`interface View {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("public", result.Value)
    }

    @Fact
    func BackwardGoto_PublicMethodDoesNotAliasExplicitInterfaceMethod() {
        let result = Evaluate(`interface View {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("public", result.Value)
    }

    @Fact
    func BackwardGoto_InheritedPublicMethodIgnoresDerivedExplicitReimplementation() {
        let result = Evaluate(`interface View {
    func Read() string;
}
open class Base {
    func Read() string -> "public"
}
class Dog : Base, View {
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("public", result.Value)
    }

    @Fact
    func BackwardGoto_InheritedPublicIndexerIgnoresDerivedExplicitReimplementation() {
        let result = Evaluate(`interface View {
    prop this[index int32] string { get; }
}
open class Base {
    prop this[index int32] string -> "public"
}
class Dog : Base, View {
    private prop (View) this[index int32] string -> "explicit"
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("public", result.Value)
    }

    @Fact
    func BackwardGoto_ImportedInheritedPublicMethodIgnoresDerivedExplicitReimplementation() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

func Run() string {
    var x Issue4519ImportedInheritedView = Issue4519ImportedInheritedDog()
    var count = 0
    if x is Issue4519ImportedInheritedDog {
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

Run()`, []string{typeof(Issue4519ImportedInheritedView).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Equal("public", result.Value)
    }

    @Fact
    func BackwardGoto_ImportedInheritedPropertyWriteDoesNotRequireNarrowedType() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

func Run() string {
    var x Issue4519ImportedWritableBase = Issue4519ImportedWritableDog()
    var count = 0
    if x is Issue4519ImportedWritableDog {
    Again:
        x.Name = "updated"
        if count == 0 {
            count++
            x = Issue4519ImportedWritableCat()
            goto Again
        }
        return x.Name
    }
    return ""
}

Run()`, []string{typeof(Issue4519ImportedWritableBase).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Equal("updated", result.Value)
    }

    @Fact
    func BackwardGoto_ImportedInheritedFieldWriteDoesNotRequireNarrowedType() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

func Run() string {
    var x Issue4519ImportedWritableBase = Issue4519ImportedWritableDog()
    var count = 0
    if x is Issue4519ImportedWritableDog {
    Again:
        x.Label = "updated"
        if count == 0 {
            count++
            x = Issue4519ImportedWritableCat()
            goto Again
        }
        return x.Label
    }
    return ""
}

Run()`, []string{typeof(Issue4519ImportedWritableBase).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Equal("updated", result.Value)
    }

    @Fact
    func BackwardGoto_ParenthesizedInheritedPropertyWriteDoesNotRequireNarrowedType() {
        let result = Evaluate(`open class Animal {
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
        (x).Name = "updated"
        if count == 0 {
            count++
            x = Cat{}
            goto Again
        }
        return x.Name
    }
    return ""
}

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("updated", result.Value)
    }

    @Fact
    func CovariantPropertyOverride_ReadThroughNarrowedReceiverKeepsDerivedType() {
        let result = Evaluate(`open class Animal {
}
class Dog : Animal {
    func Bark() string -> "woof"
}
open class Owner {
    open prop Pet Animal -> Animal{}
}
class DogOwner : Owner {
    override prop Pet Dog -> Dog{}
}

func Run() string {
    var x Owner = DogOwner{}
    if x is DogOwner {
        return x.Pet.Bark()
    }
    return ""
}

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("woof", result.Value)
    }

    @Fact
    func CovariantIndexerOverride_ReadThroughNarrowedReceiverKeepsDerivedType() {
        let result = Evaluate(`open class Animal {
}
class Dog : Animal {
    func Bark() string -> "woof"
}
open class Owner {
    open prop this[index int32] Animal -> Animal{}
}
class DogOwner : Owner {
    override prop this[index int32] Dog -> Dog{}
}

func Run() string {
    var x Owner = DogOwner{}
    if x is DogOwner {
        return x[0].Bark()
    }
    return ""
}

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("woof", result.Value)
    }

    @Fact
    func BackwardGoto_GenericOwnerIndexerReadKeepsDeclaredSlot() {
        let result = Evaluate(`open class Box[T] {
    var Stored T
    init(value T) { Stored = value }
    open prop this[index int32] T { get { return Stored } set { Stored = value } }
}
class Dog : Box[string] {
    init() : base("dog") { }
}
class Cat : Box[string] {
    init() : base("cat") { }
}

func Run() string {
    var x Box[string] = Dog{}
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("cat", result.Value)
    }

    @Fact
    func BackwardGoto_RenamedTypeParameterPropertyWriteKeepsDeclaredSlot() {
        let result = Evaluate(`open class Base[T] {
    open prop Name T { get; set; }
}
open class Mid[U] : Base[U] {
    override prop Name U { get; set; }
}
class Dog : Mid[string] {
}
class Cat : Mid[string] {
}

func Run() string {
    var x Mid[string] = Dog{}
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

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("updated", result.Value)
    }

    @Fact
    func BackwardGoto_SiblingInterfacePropertySlotsDoNotAlias() {
        let result = Evaluate(`interface Left {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Value", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_ImportedPublicMethodDoesNotAliasExplicitInterfaceMethod() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

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

Run()`, []string{typeof(Issue4519ImportedCallReceiver).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Equal("public", result.Value)
    }

    @Fact
    func BackwardGoto_ImportedRefReturnsRecoverDeclaredBaseSlots() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

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

Run()`, []string{typeof(Issue4519ImportedRefBase).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Equal(44, result.Value)
    }

    @Fact
    func ForwardGoto_FinallyDirectSourceCallInvalidatesGlobalNarrowing() {
        let result = Evaluate(`var text string? = nil

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallySourcePropertyReadInvalidatesGlobalNarrowing() {
        let result = Evaluate(`var text string? = nil

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallySourcePropertyWriteInvalidatesGlobalNarrowing() {
        let result = Evaluate(`var text string? = nil

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallySourcePropertyReadInvalidatesMemberPathNarrowing() {
        let result = Evaluate(`data class Box(Value string?) {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_FinallySourceConstructionInvalidatesGlobalNarrowing() {
        let result = Evaluate(`var text string? = nil

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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_MemberPathDeclaredBaseConversionRemainsValid() {
        AssertRuns(`import System

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

Console.WriteLine(Run())`, "cat")
    }

    @Fact
    func BackwardGoto_CapturedSiblingAssignmentPreservesDeclaredBaseConversion() {
        let result = Evaluate(`open class Animal {
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

Select(false, Holder{Callback: func() { }}).Read()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("cat", result.Value)
    }

    @Fact
    func BackwardGoto_ConstructedGenericPropertyGuardRetainsNullableType() {
        let result = Evaluate(`class Box[T] {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_ConstructedGenericInterfacePropertyGuardRetainsNullableType() {
        let result = Evaluate(`interface IBox[T] {
    prop Value T { get; set; }
}
class Box : IBox[string?] {
    var Stored string?
    public prop Value string? {
        get { return Stored }
        set { Stored = value }
    }
}

func Run() int32 {
    var box IBox[string?] = Box{Stored: "safe"}
    var count = 0
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
    return 0
}

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func DeclaredAccessPathProjectsConstructedInterfacePropertyType() {
        let tree = SyntaxTree.Parse(SourceText.From(`interface IBox[T] {
    prop Value T { get; }
}`))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let definition = Assert.Single(compilation.GlobalScope.Interfaces)
        let property = Assert.Single(definition.Properties)
        let nullableString = NullableTypeSymbol.Get(TypeSymbol.String)
        let constructed = InterfaceSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](nullableString))
        let root = LocalVariableSymbol("box", isReadOnly: false, constructed)
        let path = AccessPath.ForVariable(root).Append(property)
        Assert.Same(nullableString, MemberLookup.GetDeclaredAccessPathType(path, TypeSymbol.Error))
    }

    @Fact
    func BackwardGoto_ConstructedGenericFieldGuardRetainsNullableType() {
        let result = Evaluate(`class Box[T] {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func ForwardGoto_ThroughNonCompletingFinally_DoesNotActivateTargetEdges() {
        AssertRuns(`func Run(enter bool) int32 {
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

Console.WriteLine(Run(false))`, "4")
    }

    @Fact
    func BackwardGoto_ThroughNonCompletingFinally_DoesNotActivateTargetEdges() {
        AssertRuns(`func Run() int32 {
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

Console.WriteLine(Run())`, "4")
    }

    @Fact
    func BackwardGoto_GetterOnlyPropertyDoesNotValidateSubtypeSetter() {
        let result = Evaluate(`interface View {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Value", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func BackwardGoto_SetterOnlyPropertyDoesNotValidateSubtypeGetter() {
        let result = Evaluate(`interface View {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Value", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func BackwardGoto_GetterOnlyIndexerDoesNotValidateSubtypeSetter() {
        let result = Evaluate(`interface Values {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0116")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    @Fact
    func BackwardGoto_SetterOnlyIndexerDoesNotValidateSubtypeGetter() {
        let result = Evaluate(`interface Values {
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

Run()`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0116")
        Assert.Equal("x", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult -> EmittedOracle.Evaluate(source)

        private func AssertRuns(source string, expectedLines ...string) {
            let result = Evaluate(source)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(
                string.Join(Environment.NewLine, expectedLines) + Environment.NewLine,
                result.Output.ReplaceLineEndings(Environment.NewLine)
            )
        }
    }
}

/// Imported call surface used to verify declared-receiver recovery does not rebind arguments.
interface Issue4519ImportedCallReceiver {
    /// Reads a deterministic value.
    func TryRead(key string, out value int32) bool;

    /// Applies a callback to a deterministic value.
    func Apply(selector(int32) -> int32) int32;

    /// Describes the selected dispatch slot.
    func Describe() string;
}

/// First imported implementation used as the narrowed receiver.
class Issue4519ImportedCallDog : Issue4519ImportedCallReceiver {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func TryRead(key string, out value int32) bool {
        value = 11
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Apply(selector(int32) -> int32) int32 -> selector(11)

    /// Public method that ordinary concrete lookup must retain.
    func Describe() string -> "public"

    private func (Issue4519ImportedCallReceiver) Describe() string -> "explicit"
}

/// Second imported implementation reached by the backedge.
class Issue4519ImportedCallCat : Issue4519ImportedCallReceiver {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func TryRead(key string, out value int32) bool {
        value = 22
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Apply(selector(int32) -> int32) int32 -> selector(22)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Describe() string -> "cat"
}

/// Imported interface with a generic method whose signature mentions its own type parameter.
interface Issue4519ImportedGenericMapper {
    /// Maps a value through a generic method with a constructed parameter type.
    func Map[T](value T, selector(T) -> T) T;
}

/// First imported generic-method implementation used as the narrowed receiver.
class Issue4519ImportedGenericMapperDog : Issue4519ImportedGenericMapper {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Map[T](value T, selector(T) -> T) T -> selector(value)
}

/// Second imported generic-method implementation reached by the backedge.
class Issue4519ImportedGenericMapperCat : Issue4519ImportedGenericMapper {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Map[T](value T, selector(T) -> T) T -> selector(value)
}

/// Imported interface re-implemented explicitly by a derived class over an inherited public method.
interface Issue4519ImportedInheritedView {
    /// Describes the selected dispatch slot.
    func Describe() string;
}

/// Imported base declaring the public method that a derived class inherits.
open class Issue4519ImportedInheritedBase {
    /// Public inherited method that ordinary concrete lookup must retain.
    func Describe() string -> "public"
}

/// Imported derived class that re-implements the interface explicitly.
class Issue4519ImportedInheritedDog : Issue4519ImportedInheritedBase, Issue4519ImportedInheritedView {
    private func (Issue4519ImportedInheritedView) Describe() string -> "explicit"
}

/// Imported writable base used by inherited-write recovery tests.
open class Issue4519ImportedWritableBase {
    /// Gets or sets the name.
    private var _name string = "base"

    prop Name string {
        get {
            return _name
        }
        set {
            _name = value
        }
    }

    /// Public writable field.
    var Label string = "base"
}

/// First imported writable subtype.
class Issue4519ImportedWritableDog : Issue4519ImportedWritableBase { }

/// Second imported writable subtype.
class Issue4519ImportedWritableCat : Issue4519ImportedWritableBase { }

/// Imported base with ref-returning members used by declared-slot recovery tests.
open class Issue4519ImportedRefBase {
    private var value int32

    /// Initializes the stored value.
    protected init(value int32) {
        this.value = value
    }

    /// Gets a mutable reference.
    prop Value ref int32 -> value

    /// Returns a mutable reference.
    func Read() ref int32 {
        return ref value
    }
}

/// First imported ref-return implementation.
class Issue4519ImportedRefDog : Issue4519ImportedRefBase {
    /// Initializes a dog value.
    init() : base(11) { }
}

/// Second imported ref-return implementation.
class Issue4519ImportedRefCat : Issue4519ImportedRefBase {
    /// Initializes a cat value.
    init() : base(22) { }
}

/// Imported generic property used by declared-type diagnostic tests.
class Issue4519ImportedGenericHolder[T] {
    /// Initializes the holder.
    init(value T) {
        Value = value
    }

    /// Gets the value.
    prop Value T {
        get;
    }
}
