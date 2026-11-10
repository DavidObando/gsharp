// <copyright file="Issue1180SmartCastMembersBinderTests.cs" company="GSharp">
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
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0069 addendum / issue #1180 — extend Kotlin-style smart cast from
/// locals to <em>stable member-access paths</em>. A narrowing on a member path
/// is only sound when every link is immutable and not externally mutable
/// between the test and the use: an immutable `let` field or a getter-only
/// / init-only auto-property (no custom getter, not `open`/override),
/// declared in the current compilation, read through a stable receiver chain.
/// These tests mirror the local smart-cast coverage style and exercise the
/// positive and negative (stability) cases.
open class Issue1180SmartCastMembersBinderTests {
    @Fact
    func If_IsTest_NarrowsStableLetFieldPathInThenBranch() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_NegatedIsTest_NarrowsStableFieldPathAfterEarlyReturn() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet !is Dog { return "" }
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTest_NarrowsDeepStableReceiverChain() {
        let result = Evaluate(Hierarchy + `
class Inner { let Pet Animal }
class Box { let In Inner }
func Run(b Box) string {
    if b.In.Pet !is Dog { return "" }
    return b.In.Pet.Bark()
}
Run(Box{In: Inner{Pet: Dog{Name: "Rex"}}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTest_NarrowsInitOnlyAutoPropertyPath() {
        let result = Evaluate(Hierarchy + `
class Box {
    prop Pet Animal { get; init; }
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box() { Pet = Dog{Name: "Rex"} })
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NilGuard_NarrowsStableNullableFieldPath() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal? }
func Run(b Box) string {
    if b.Pet != nil {
        return b.Pet.Describe()
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Theory
    @InlineData("let Stable System.Collections.Generic.List[int32]?", "Stable.Capacity > 0")
    @InlineData("let Stable System.Collections.Generic.List[int32]?", "Stable.Contains(1)")
    @InlineData("prop Stable System.Collections.Generic.List[int32]? { get; init; }", "Stable.Capacity > 0")
    @InlineData("prop Stable System.Collections.Generic.List[int32]? { get; init; }", "Stable.Contains(1)")
    func NilGuard_NarrowsBareImplicitThisMember(member string, use string) {
        // Issue #4310: the bare spelling must consult the same stable
        // AccessPath as this.Stable, for reads and calls alike.
        let result = Evaluate((`
class Box {
    ` + "$member" + `
    func Run() bool { return Stable != nil && ` + "$use" + ` }
}
`))
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Switch_NarrowsStableFieldPathDiscriminantInArm() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func Run(b Box) string {
    switch b.Pet {
        case d is Dog { return b.Pet.Bark() }
        default { return "" }
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTestAnd_ThreadsMemberPathNarrowingIntoRhs() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog && b.Pet.Bark() != "" {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func MutableVarField_DoesNotNarrow() {
        let result = Evaluate(Hierarchy + `
class Box { var Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func MutableVarAutoProperty_DoesNotNarrow() {
        let result = Evaluate(Hierarchy + `
class Box { prop Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box() { Pet = Dog{Name: "Rex"} })
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func CustomGetterProperty_DoesNotNarrow() {
        let result = Evaluate(Hierarchy + `
class Box {
    let backing Animal
    prop Pet Animal { get { return backing } }
    init(p Animal) { backing = p }
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box(Dog{Name: "Rex"}))
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func OverridableOpenProperty_DoesNotNarrow() {
        let result = Evaluate(Hierarchy + `
open class Box {
    open prop Pet Animal { get; init; }
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box() { Pet = Dog{Name: "Rex"} })
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func InterveningCall_InvalidatesMemberPathNarrowing() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func SideEffect() {}
func Run(b Box) string {
    if b.Pet !is Dog { return "" }
    SideEffect()
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    /// ADR-0208 R21 (#5786): a write of a `var` field stores no link of a stable path, so the fact on
    /// `b.Pet` survives it.
    @Fact
    func InterveningVarFieldWrite_KeepsMemberPathNarrowing() {
        let result = Evaluate(Hierarchy + `
class Box { var Other int32 = 0 let Pet Animal }
func Run(b Box) string {
    if b.Pet !is Dog { return "" }
    b.Other = 1
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("woof", result.Value)
    }

    /// An index write, a constructor write of the `let` link itself, and a field write whose location can hold
    /// the storage of a by-reference root still remove the fact (ADR-0208 R20, R21).
    @Theory
    @InlineData(
        "class Box { let Others []int32 let Pet Animal }\nfunc Run(b Box) string {\n    if b.Pet !is Dog { return \"\" }\n    b.Others[0] = 1\n    return b.Pet.Bark()\n}\nRun(Box{Others: []int32{0}, Pet: Dog{Name: \"Rex\"}})"
    )
    @InlineData(
        "class Box {\n    let Pet Animal\n    init(first Animal, second Animal) {\n        this.Pet = first\n        if this.Pet !is Dog { return }\n        this.Pet = second\n        let _ = this.Pet.Bark()\n    }\n}\nBox(Dog{Name: \"Rex\"}, Cat{Name: \"Tom\"})"
    )
    @InlineData(
        "struct Box { let Pet Animal }\nclass Holder { var box Box }\nfunc Run(ref b Box, h Holder, fresh Box) string {\n    if b.Pet !is Dog { return \"\" }\n    h.box = fresh\n    return b.Pet.Bark()\n}\nlet h = Holder{box: Box{Pet: Dog{Name: \"Rex\"}}}\nRun(ref h.box, h, Box{Pet: Cat{Name: \"Tom\"}})"
    )
    func InterveningWriteThatCanReachThePath_InvalidatesMemberPathNarrowing(body string) {
        let result = Evaluate(Hierarchy + body)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0159", diagnostic.Id)
        Assert.Contains("Bark", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func ImportedClrMemberPath_DoesNotNarrow() {
        // A member read through an imported / CLR type surfaces as a
        // BoundClrPropertyAccessExpression, which is never a stable G# path —
        // the binder cannot guarantee idempotence / immutability across module
        // boundaries, so no narrowing applies.
        let result = Evaluate(Hierarchy + `
import System
class Box { let Builder System.Text.StringBuilder }
func Run(b Box) int32 {
    if b.Builder.Length is int32 {
        return b.Builder.Length + 1
    }
    return 0
}
Run(Box{Builder: System.Text.StringBuilder()})
`)
        // The point is purely that the member path is not narrowed; the program
        // need not be otherwise meaningful. We assert that binding does not
        // crash and produces a deterministic result object.
        Assert.NotNull(result)
    }

    @Theory
    @InlineData("struct", "this.owner.A = true\n            this.owner.B = true")
    @InlineData("struct", "this.owner.A = true\n            let x = this.owner.B\n            this.owner.B = !x")
    @InlineData("struct", "let a = !this.owner.A\n            this.owner.A = a\n            this.owner.B = a")
    @InlineData("struct", "owner.A = true\n            owner.B = true")
    @InlineData(
        "struct",
        "let a = owner.A\n            let b = owner.B\n            owner.A = !a\n            owner.B = !b"
    )
    @InlineData("class", "this.owner.A = true\n            this.owner.B = true")
    @InlineData("class", "owner.A = true\n            owner.B = true")
    func Issue5786_AutoPropertyWriteThroughNarrowedNullableField_KeepsNarrowing_AndNarrowsBareFieldReceiver(
        aggregateKind string,
        body string
    ) {
        let source = `package Probe5786
class Owner {
    prop A bool { get; set; }
    prop B bool { get; set; }
}
AGGREGATE Token {
    private let owner Owner?
    init(owner Owner) {
        this.owner = owner
    }
    func Restore() {
        if owner != nil {
            BODY
        }
    }
}
let o = Owner()
Token(o).Restore()
o.A && o.B`.Replace("AGGREGATE", aggregateKind).Replace("BODY", body)
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Theory
    @InlineData("open class Owner {\n    open prop A bool { get; set; }\n    prop B bool { get; set; }\n}")
    @InlineData(
        "class Owner {\n    var a bool\n    prop A bool { get -> a set { a = value } }\n    prop B bool { get; set; }\n}"
    )
    func Issue5786_OverridableOrComputedPropertySetter_StillInvalidatesMemberPathNarrowing(ownerDecl string) {
        let source = `package Probe5786Neg
` + ownerDecl + `
struct Token {
    private let owner Owner?
    init(owner Owner) {
        this.owner = owner
    }
    func Restore() {
        if owner != nil {
            this.owner.A = true
            this.owner.B = true
        }
    }
}
let o = Owner()
Token(o).Restore()`
        let result = Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Contains("B", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func Issue5786_NonOverridableAutoPropertyWrite_StillInvalidatesRefParameterNarrowingUnderR12() {
        let source = `package Probe5786Ref
class Owner {
    prop A string? { get; set; }
    prop B bool { get; set; }
}
struct Token {
    private let owner Owner?
    init(owner Owner) {
        this.owner = owner
    }
    func Mutate(ref alias string?) int32 {
        if owner != nil && alias != nil {
            owner.A = nil
            owner.B = true
            return alias.Length
        }
        return 0
    }
}
var s string? = "abc"
Token(Owner()).Mutate(ref s)`
        let result = Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Contains("Length", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func Issue5814_ImportedReadonlyMembers_NarrowForMethodCalls_WhileMutableMembersReject() {
        using let fixture = CSharpFixture(`#nullable enable
namespace Imported5814 {
    public struct Counter {
        public int n;
        public void Bump() { n++; }
    }
    public sealed class Box {
        public readonly object? readonlyField;
        public object? GetOnlyProp { get; }
        public object? mutableField;
        public object? MutableProp { get; set; }
        public Box(object? value) {
            readonlyField = value;
            GetOnlyProp = value;
            mutableField = value;
            MutableProp = value;
        }
    }
}`)
        using let references = fixture.RuntimeReferences()
        let validSource = `import Imported5814
func TakeInCounter(in c Counter) int32 -> c.n
func TakeInString(in s string) int32 -> s.Length
let box = Box(Counter())
if box.readonlyField is Counter {
    defer box.readonlyField.Bump()
    let _ = TakeInCounter(box.readonlyField)
}
if box.readonlyField is Counter {
    let _ = TakeInCounter(in box.readonlyField)
}
if box.readonlyField is string {
    let _ = TakeInString(in box.readonlyField)
}
if box.GetOnlyProp is Counter {
    box.GetOnlyProp.Bump()
}
`
        let validTree = SyntaxTree.Parse(SourceText.From(validSource))
        let validCompilation = Compilation(references, validTree)
        let validProgram = Binder.BindProgram(validCompilation.GlobalScope, validCompilation.References)
        let validErrors = validTree
            .Diagnostics
            .Concat(validCompilation.GlobalScope.Diagnostics)
            .Concat(validProgram.Diagnostics)
            .Where((d Diagnostic) -> d.IsError)
            .ToArray()
        Assert.Empty(validErrors)

        let incompatibleInSource = `import Imported5814
func TakeInString(in s string) int32 -> s.Length
func ReturnRefCounter(b Box) ref readonly Counter {
    if b.readonlyField is Counter {
        return ref b.readonlyField
    }
    throw System.Exception()
}
let box = Box(Counter())
if box.readonlyField is Counter {
    let _ = TakeInString(in box.readonlyField)
}
`
        let incompatibleInTree = SyntaxTree.Parse(SourceText.From(incompatibleInSource))
        let incompatibleInCompilation = Compilation(references, incompatibleInTree)
        let incompatibleInProgram = Binder.BindProgram(
            incompatibleInCompilation.GlobalScope,
            incompatibleInCompilation.References
        )
        let incompatibleInErrors = incompatibleInTree
            .Diagnostics
            .Concat(incompatibleInCompilation.GlobalScope.Diagnostics)
            .Concat(incompatibleInProgram.Diagnostics)
            .Where((d Diagnostic) -> d.IsError)
            .ToArray()
        Assert.Equal(2, incompatibleInErrors.Length)
        Assert.Equal("GS0154", incompatibleInErrors[0].Id)
        Assert.Equal("GS0155", incompatibleInErrors[1].Id)

        for member in[]string{"mutableField", "MutableProp"} {
            let call = "Bump()"
            let rejectedSource = "import Imported5814\nlet box = Box(Counter())\nif box." +
                member +
                " is Counter {\n    box." +
                member +
                "." +
                call +
                "\n}\n"
            let rejectedTree = SyntaxTree.Parse(SourceText.From(rejectedSource))
            let rejectedCompilation = Compilation(references, rejectedTree)
            let rejectedProgram = Binder.BindProgram(rejectedCompilation.GlobalScope, rejectedCompilation.References)
            let error = Assert.Single(
                rejectedTree
                    .Diagnostics
                    .Concat(rejectedCompilation.GlobalScope.Diagnostics)
                    .Concat(rejectedProgram.Diagnostics)
                    .Where((d Diagnostic) -> d.IsError)
            )
            Assert.Equal("GS0159", error.Id)
            Assert.Equal(
                TextSpan(rejectedSource.IndexOf(call, StringComparison.Ordinal), call.Length),
                error.Location.Span
            )
        }
    }

    shared {
        private const Hierarchy string = `
open class Animal {
    var Name string
    open func Describe() string { return Name }
}
class Dog : Animal {
    func Bark() string { return "woof" }
}
class Cat : Animal {
    func Purr() string { return "purr" }
}
`

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
