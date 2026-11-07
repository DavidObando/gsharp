// <copyright file="Issue2159IfJoinNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import Xunit

/// Issue #2159 — narrow a nullable `var` local to its non-nullable
/// underlying type at the JOIN point after an `if` when the local is
/// non-null on <em>every</em> branch exit (via assignment inside the branch
/// and/or condition-implied narrowing). Generalises the straight-line
/// assignment narrowing (issue #1123) and the early-exit narrowing
/// (issue #700) to the "null-check then reassign in the null branch" idiom.
/// Covers the positive repros, the generic form, the negative controls that
/// must still block narrowing, an `else if` chain, and post-if
/// re-nullable-ization.
open class Issue2159IfJoinNarrowingTests {
    @Fact
    func FinallyAssignedOutWrite_DischargesNullableWidening() {
        let result = Evaluate(`package T
import System.Collections.Generic
func Write(out target string) int32 {
    target = "safe"
    return 0
}
func Run(dict Dictionary[string, string]) int32 {
    var value string = ""
    var count = 0
    if dict.TryGetValue("key", &value) { return 0 }
    try { } finally { count = Write(&value) }
    return value.Length
}
Console.WriteLine(Run(Dictionary[string, string]()))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("4\n", result.Output.ReplaceLineEndings("\n"))
    }

    @Fact
    func FinallyOutWrite_DischargesNullableWidening() {
        let result = Evaluate(`package T
import System.Collections.Generic
func Write(out target string) { target = "safe" }
func Run(dict Dictionary[string, string]) int32 {
    var value string = ""
    if dict.TryGetValue("key", &value) { return 0 }
    try { } finally { Write(&value) }
    return value.Length
}
Console.WriteLine(Run(Dictionary[string, string]()))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("4\n", result.Output.ReplaceLineEndings("\n"))
    }

    @Fact
    func FinallyOutWrite_LaterNullableWriteRemovesTheProof() {
        let result = Evaluate(`package T
import System.Collections.Generic
func Write(out target string) { target = "safe" }
func Run(dict Dictionary[string, string]) int32 {
    var value string = ""
    if dict.TryGetValue("key", &value) { return 0 }
    try { } finally {
        Write(&value)
        dict.TryGetValue("missing", &value)
    }
    return value.Length
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func NativeMapRead_InvalidatesBeforeTheNextOperand() {
        let result = Evaluate(`package T
class Key {
    var Callback () -> void
    override func GetHashCode() int32 {
        Callback()
        return 1
    }
}
func Run() int32 {
    var text string? = nil
    let key = Key{}
    key.Callback = func() { text = nil }
    var m = map[Key, int32]{key: 0}
    var safe = []string?{nil}
    safe[0] = (text = "safe")
    return m[key] + text.Length
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func AssignmentBlockReplay_KeepsEntryExternalAliases() {
        let result = Evaluate(`package T
func External() { }
func Run(callback () -> void) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = callback
    var n = 0
    n = ({
        text = "safe"
        action()
        action = clear
        0
    })
    return text.Length
}
Console.WriteLine(Run(External))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("4\n", result.Output.ReplaceLineEndings("\n"))
    }

    @Fact
    func AssignmentBlockReplay_UsesEntryCallableAliases() {
        let result = Evaluate(`package T
func Run(callback () -> void) int32 {
    var text string? = nil
    var action = func() { text = nil }
    var n = 0
    n = ({
        text = "safe"
        action()
        action = callback
        0
    })
    return text.Length
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData(`m[key] = (text = "safe")`)
    @InlineData(`n = ({
        text = "safe"
        let unused = m[key]
        0
    })`)
    func NativeMapHashCallback_RemovesNestedAssignmentFacts(body string) {
        let result = Evaluate(`package T
class Key {
    var Callback () -> void
    override func GetHashCode() int32 {
        Callback()
        return 1
    }
}
func Run() int32 {
    var text string? = nil
    let key = Key{}
    key.Callback = func() { text = nil }
    var m = map[Key, string?]{key: nil}
    var n = 0
    ` + body + `
    return text.Length
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func NativeMapSetter_PreservesAnUncapturedLocal() {
        let result = Evaluate(`package T
func Run() int32 {
    var text string? = nil
    var m = map[int32, string?]{}
    m[0] = (text = "safe")
    return text.Length
}
Console.WriteLine(Run())
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("4\n", result.Output.ReplaceLineEndings("\n"))
    }

    @Fact
    func NativeMapCustomComparer_RemovesCapturedAssignmentFacts() {
        let result = Evaluate(`package T
import System.Collections.Generic
class Comparer : IEqualityComparer[int32] {
    var Callback () -> void
    func Equals(left int32, right int32) bool -> left == right
    func GetHashCode(value int32) int32 {
        Callback()
        return value
    }
}
func Run() int32 {
    var text string? = nil
    let comparer = Comparer{}
    comparer.Callback = func() { text = nil }
    var m map[int32, string?] = Dictionary[int32, string?](comparer)
    m[0] = (text = "safe")
    return text.Length
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func DictionaryAssignmentValue_DischargesTheFailedLookupWidening() {
        let result = Evaluate(`package T
import System.Collections.Generic
func Run(dict Dictionary[string, HashSet[string]]) int32 {
    if !dict.TryGetValue("key", out var set) {
        dict["key"] = (set = HashSet[string]())
    }
    set.Add("ok")
    return set.Count
}
let dict = Dictionary[string, HashSet[string]]()
Console.WriteLine(Run(dict))
Console.WriteLine(Run(dict))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("1\n1\n", result.Output.ReplaceLineEndings("\n"))
    }

    @Theory
    @InlineData(`dict["key"] = (value = "safe")`)
    @InlineData(`items[0] = (value = "safe")`)
    @InlineData(`holder.Field = (value = "safe")`)
    @InlineData(`holder.Value = (value = "safe")`)
    @InlineData(`holder[0] = (value = "safe")`)
    @InlineData(`info.ReasonPhrase = (value = "safe")`)
    @InlineData(`other = (value = "safe")`)
    func AssignmentValueWrappers_EstablishNullableLocalFacts(assignment string) {
        let result = Evaluate(`package T
import System.Collections.Generic
import System.Net.Http
class Holder {
    var Field string? = nil
    prop Value string? { set { } }
    prop this[index int32] string? { set { } }
}
func Run() int32 {
    let dict = Dictionary[string, string?]()
    var items = []string?{nil}
    let holder = Holder{}
    let info = HttpResponseMessage()
    var other string? = nil
    var value string? = nil
    ` + assignment + `
    return value.Length
}
Console.WriteLine(Run())
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("4\n", result.Output.ReplaceLineEndings("\n"))
    }

    @Theory
    @InlineData(`holder.Value = (value = "safe")`)
    @InlineData(`holder[0] = (value = "safe")`)
    func AssignmentValueSetterCallback_DoesNotDischargeWidening(assignment string) {
        let result = Evaluate(`package T
import System.Collections.Generic
class Holder {
    var Callback () -> void
    prop Value string { set { Callback() } }
    prop this[index int32] string { set { Callback() } }
}
func Run() int32 {
    let dict = Dictionary[string, string]()
    var value string = ""
    let holder = Holder{}
    holder.Callback = func() { dict.TryGetValue("missing", &value) }
    if !dict.TryGetValue("key", &value) {
        ` + assignment + `
    }
    return value.Length
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func ExpressionLabel_DoesNotRestoreThePreStatementProof() {
        let result = Evaluate(`package T
func Run(jump bool) {
    var x string? = nil
    if jump { goto L }
    if x == nil { return } else let unused = ({
        L: var marker = 0
        0
    })
    Console.WriteLine(x.Length)
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData("if x != nil { }")
    @InlineData("if x == nil { }")
    @InlineData("if var n = 1; x != nil && n == 1 { }")
    func NilRecheck_PreservesTheStrongerSubtype(recheck string) {
        let result = Evaluate(`package T
open class Animal { }
class Dog : Animal { func Bark() string { return "woof" } }
func Run(x Animal?) string {
    if x !is Dog { return "" }
    ` + recheck + `
    return x.Bark()
}
Console.WriteLine(Run(Dog{}))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("woof\n", result.Output.ReplaceLineEndings("\n"))
    }

    @Fact
    func BranchRefinement_DoesNotChangeTheSiblingEntry() {
        let result = Evaluate(`package T
open class Animal { }
class Dog : Animal { func Bark() string { return "woof" } }
func Run(x Animal?, flag bool) string {
    if x == nil { return "" }
    if flag {
        if x !is Dog { return "" }
    } else {
        return x.Bark()
    }
    return ""
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0159", diagnostic.Id)
        Assert.Equal("Bark()", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func UnbracedOutCall_PreservesTheNullableWidening() {
        let result = Evaluate(`package T
import System.Collections.Generic
func Run(dict Dictionary[string, string], flag bool) int32 {
    var value string = ""
    if !dict.TryGetValue("key", &value) {
        if flag dict.TryGetValue("other", &value)
        return value.Length
    }
    return 0
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData("")
    @InlineData("var n = 0; ")
    func ConditionCall_DoesNotRestoreACallerOwnedFact(initializer string) {
        let result = Evaluate(`package T
class C { var Value int32 = 1 }
func Clear(values []C?) bool {
    values[0] = nil
    return true
}
func Run(ref value C?, values []C?) int32 {
    if ` + initializer + `value != nil && Clear(values) {
    } else { return 0 }
    return value.Value
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Value", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func DeferredWrite_EndsTheBranchFactBeforeItsNormalExit() {
        let result = Evaluate(`package T
func Run(flag bool, input string?) int32 {
    var s = input
    let clear = func() { s = nil }
    if s == nil { return 0 }
    if flag {
        defer clear()
    } else { }
    return s.Length
}
`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData(`if flag {
        s = nil
        return -1
    }`)
    @InlineData(`if flag {
        s = nil
        return -1
    } else { }`)
    @InlineData(`if var n = 1; flag && n == 1 {
        s = nil
        return -1
    }`)
    func ExitingBranchWrite_DoesNotRemoveTheSurvivingFact(branch string) {
        let result = Evaluate(`package T
func Run(flag bool, input string?) int32 {
    var s = input
    if s == nil { return 0 }
    ` + branch + `
    return s.Length
}
Console.WriteLine(Run(false, "abc"))
Console.WriteLine(Run(true, "abc"))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("3\n-1\n", result.Output.ReplaceLineEndings("\n"))
    }

    @Theory
    @InlineData(`switch 1 { case 1 { s = "abc" } default { return -1 } }`)
    @InlineData(`switch 1 {
        case 1 {
            s = "abc"
            break
        }
        default { return -1 }
    }`)
    @InlineData(`switch 1 {
        case 1 {
            try { break } finally { s = "abc" }
        }
        default { return -1 }
    }`)
    @InlineData(`for {
        s = "abc"
        break
    }`)
    @InlineData(`try { s = "abc" } catch { s = "abc" }`)
    func NestedStatement_ContributesItsNormalExitState(body string) {
        let result = Evaluate(`package T
func Run(flag bool) int32 {
    var s string? = nil
    if flag {
        ` + body + `
    } else {
        s = "abc"
    }
    return s.Length
}
Console.WriteLine(Run(true))
Console.WriteLine(Run(false))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("3\n3\n", result.Output.ReplaceLineEndings("\n"))
    }

    @Fact
    func ReassignInNullBranch_NoElse_Narrows() {
        // Repro (1): non-null branch reached via the implicit negated-condition
        // else (`r != nil`); the then-branch reassigns `r` to a non-null value.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f1(s string?) string {
    var r string? = s
    if r == nil { r = mk() }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func AssignNonNullInBothBranches_Narrows() {
        // Repro (2): then assigns a fresh non-null value; else assigns the
        // condition-narrowed (non-null) parameter.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f2(s string?) string {
    var r string?
    if s == nil { r = mk() } else { r = s }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericClassConstrained_Narrows() {
        // Repro (3): generic form; `T` carries a `class` constraint so `T?` → `T`
        // is a metadata-only narrowing.
        let result = Evaluate(`
package T
func f3[T class init()](s object?) T {
    var r T? = s as T
    if r == nil { r = T() }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ElseIfChain_EveryTerminalBranchNonNull_Narrows() {
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(a bool, s string?) string {
    var r string? = s
    if a { r = mk() } else if r == nil { r = mk() } else { r = mk() }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func EarlyExitInNullBranch_StillNarrows() {
        // Regression guard: the already-working early-exit idiom stays clean.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(s string?) string {
    var r string? = s
    if r == nil { return mk() }
    return r
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UnrelatedBool_NoElse_DoesNotNarrow() {
        // Negative: the implicit else leaves `r` at its declared nullable type
        // because the condition does not narrow it.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(c bool) string {
    var r string?
    if c { r = mk() }
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    @Fact
    func EmptyThen_DoesNotNarrow() {
        // Negative: the then-branch leaves `r` nil.
        let result = Evaluate(`
package T
func f(s string?) string {
    var r string? = s
    if r == nil { }
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    @Fact
    func AssignNullableInBranch_DoesNotNarrow() {
        // Negative: the branch assigns a possibly-null value, so `r` is not
        // proven non-null on that exit.
        let result = Evaluate(`
package T
func maybe() string? -> nil
func f(s string?) string {
    var r string? = s
    if r == nil { r = maybe() }
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    @Fact
    func ReassignToNilAfterNonNull_DoesNotNarrow() {
        // Negative: a later reassignment to nil inside the branch clears the
        // non-null fact established by the earlier assignment.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(s string?) string {
    var r string? = s
    if r == nil {
        r = mk()
        r = nil
    }
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    @Fact
    func PostIfReassignToNull_ReNullableIzes() {
        // The join narrows `r`, but a subsequent reassignment to nil invalidates
        // it, so the later use fails again.
        let result = Evaluate(`
package T
func mk() string -> "x"
func f(s string?) string {
    var r string? = s
    if r == nil { r = mk() }
    r = nil
    return r
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert", StringComparison.Ordinal)
        )
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
