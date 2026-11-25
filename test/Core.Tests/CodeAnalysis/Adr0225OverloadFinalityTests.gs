// <copyright file="Adr0225OverloadFinalityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0225 D6.5 and its follow-ups (#6078): overload, argument, operator and conversion reports of a
/// prefix bind, and the end-of-construct checks of function literals, top-level statements and switch
/// expressions. Each test binds a prefix and builds completions of it. A final diagnostic must stay
/// reported, at the same ID and span, in every completion. A witness completion removes each
/// future-dependent diagnostic.
open class Adr0225OverloadFinalityTests {
    @Fact
    func SourceFunctionCall_WrongArguments_CanBeALaterOverload() {
        const prefix = `package P

func Add(a int32, b int32) int32 {
    return a + b
}

func Main() {
    let x = Add(1)
    let y = Add(1, "two")
`
        const witness = `}

func Add(a int32) int32 {
    return a
}

func Add(a int32, b string) int32 {
    return a
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0144", "GS0154")
        AssertFutureDependent(result, "GS0144", "later-declaration")
        AssertFutureDependent(result, "GS0154", "later-declaration")
        // Every later declaration is present.
        for d in BindKeep(prefix + "/*CUT*/}\n").Diagnostics {
            Assert.Equal(DiagnosticFinality.Final, d.Finality)
        }
    }

    @Fact
    func MemberCall_WrongArguments_CanBeALaterMember() {
        const prefix = `package P

partial class Box {
    func Put(v int32) {
    }
}

func Main() {
    let b = Box()
    b.Put("s")
    b.Put()
`
        const witness = `}

partial class Box {
    func Put(s string) {
    }

    func Put() {
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0154", "GS0144")
        AssertFutureDependent(result, "GS0154", "later-member")
        AssertFutureDependent(result, "GS0144", "later-member")
        let keep = BindKeep(prefix + "/*CUT*/}\n").Diagnostics
        Assert.Equal(2, keep.Length)
        Assert.All(keep, (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.Final, d.Finality))
    }

    @Fact
    func ConstructorCall_WrongArguments_CanBeALaterConstructor() {
        const prefix = `package P

partial class Box {
    init(v int32) {
    }
}

func Main() {
    let b = Box("s")
`
        const witness = `}

partial class Box {
    init(s string) {
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0154")
        AssertFutureDependent(result, "GS0154", "later-declaration")
    }

    @Fact
    func CallOfALocalFunctionValue_WrongArguments_IsFinal() {
        const prefix = `package P

func Main() {
    let f = func (a int32) int32 {
        return a
    }
    let x = f(1, 2)
    let y = f("s")
`
        // Neither a later function nor a later local can change the signature of `f`.
        let result = BindNothing(
            prefix,
            []string{
                "}\n",
                "}\n\nfunc f(a int32, b int32) int32 {\n    return a\n}\n",
                "    let f = func (a string) int32 {\n        return 0\n    }\n}\n"
            }
        )
        Assert.Equal(
            []string{"GS0144", "GS0155"},
            result.Diagnostics.Select((d ClassifiedDiagnostic) -> d.Diagnostic.Id).ToArray()
        )
        Assert.All(result.Diagnostics, (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.Final, d.Finality))
    }

    @Fact
    func FunctionLiteralArgument_DependsOnTheCandidate() {
        const prefix = `package P

class A {
}

class B {
    prop Size int32 -> 1
}

func Run(f (A) -> int32) {
}

func Main() {
    Run((x) -> x.Size)
`
        // A later overload changes the type of the literal and removes the conversion report.
        const witness = `}

func Run(f (B) -> int32) {
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-declaration")
    }

    @Fact
    func StaticCallOfAnImportedType_CanBeHiddenByALaterType() {
        const prefix = `package P

import System

func Main() {
    let x = Math.Max(1)
`
        const witness = `}

class Math {
    shared {
        func Max(a int32) int32 {
            return a
        }
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0159")
        AssertFutureDependent(result, "GS0159", "later-member")
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(BindKeep(prefix + "/*CUT*/}\n").Diagnostics).Finality)
    }

    @Fact
    func UndefinedOperator_CanBeALaterReceiverOperator() {
        const prefix = `package P

class V {
    var X int32
}

func Main() {
    let a = V()
    let b = a + a
    let c = "s" * 2
`
        const witness = `}

func (a V) operator + (b V) V {
    return a
}

func (a string) operator * (b int32) string {
    return a
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0129")
        Assert.Equal(2, result.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0129"))
        AssertFutureDependent(result, "GS0129", "later-member")
        let keep = BindKeep(prefix + "/*CUT*/}\n").Diagnostics
        Assert.Equal(2, keep.Length)
        Assert.All(keep, (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.Final, d.Finality))
    }

    @Fact
    func MissingConversion_DependsOnWhetherALaterConversionCanBeDeclared() {
        const prefix = `package P

struct Meters {
    var V float64
}

func Main() {
    let m Meters = 3.0
`
        const witness = `}

func operator implicit (v float64) Meters {
    return Meters{V: v}
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-declaration")
        // A conversion needs a type of this package on one side (ADR-0120).
        const builtin = `package P

func Main() {
    let m int32 = "s"
`
        let final = BindNothing(
            builtin,
            []string{"}\n", "}\n\nfunc operator implicit (s string) int32 {\n    return 0\n}\n"}
        )
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(final.Diagnostics).Finality)
    }

    @Fact
    func GotoInAnOpenFunctionLiteral_CanBeALaterLabel() {
        let prefixes = []string{
            "package P\n\nfunc Main() {\n    let f = func () {\n        goto done\n",
            "package P\n\nfunc Main() {\n    let f = (x int32) -> {\n        goto done\n"
        }
        let witnesses = []string{
            "        done:\n        var x = 1\n    }\n}\n",
            "        done:\n        return x\n    }\n}\n"
        }
        for var i = 0; i < prefixes.Length; i++ {
            let result = BindNothing(prefixes[i], []string{witnesses[i]})
            AssertWitness(prefixes[i] + witnesses[i], "GS0469")
            AssertFutureDependent(result, "GS0469", "rest-of-body")
        }
        // A closed literal cannot get the label.
        const closed = "package P\n\nfunc Main() {\n    let f = func () {\n        goto done\n    }\n"
        let final = BindNothing(closed, []string{"}\n", "done:\n}\n"})
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(final.Diagnostics).Finality)
    }

    @Fact
    func GotoInTopLevelStatements_CanBeALaterLabel() {
        const prefix = "package P\n\nvar reached = false\ngoto done\n"
        const witness = "done:\nreached = true\n"
        let result = BindNothing(prefix, []string{witness})
        AssertWitness(prefix + witness, "GS0469")
        AssertFutureDependent(result, "GS0469", "rest-of-body")
        // The bind removes the later top-level statements.
        AssertFutureDependent(BindKeep(prefix + "/*CUT*/" + witness), "GS0469", "rest-of-body")
        // The later top-level statements are kept when the cut is in a member.
        const inMember = "package P\n\nvar reached = false\ngoto done\n\nfunc Helper() {\n    let a = 1\n/*CUT*/\n}\n"
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(BindKeep(inMember).Diagnostics).Finality)
    }

    @Fact
    func OpenSwitchExpression_CanGetTheMissingArms() {
        const prefix = `package P

enum Color { Red, Green }

func Name(c Color, v int32) object {
    let e = switch c {
        case Color.Red: "r"
`
        const enumWitness = `        case Color.Green: "g"
    }
    return e
}
`
        let enumResult = BindNothing(prefix, []string{enumWitness})
        AssertWitness(prefix + enumWitness, "GS0177")
        AssertFutureDependent(enumResult, "GS0177", "rest-of-statement")
        const intPrefix = `package P

func Name(v int32) object {
    let s = switch v {
        case 1: "one"
        case 2: 2
`
        // A later arm adds the default and widens the result type of the arms.
        const intWitness = `        default: cast[object](1)
    }
    return s
}
`
        let intResult = BindNothing(intPrefix, []string{intWitness})
        AssertWitness(intPrefix + intWitness, "GS0176", "GS0179")
        AssertFutureDependent(intResult, "GS0176", "rest-of-statement")
        AssertFutureDependent(intResult, "GS0179", "rest-of-statement")
        // A closed switch expression cannot get arms.
        const closed = "package P\n\nfunc Name(v int32) string {\n    let s = switch v {\n        case 1: \"one\"\n    }\n"
        let final = BindNothing(closed, []string{"    return s\n}\n"})
        Assert.Equal(
            DiagnosticFinality.Final,
            final.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0176").Finality
        )
    }

    @Fact
    func CallOfALocalInAFunctionLiteral_CanBeALaterLocal() {
        const prefix = `package P

func Main() {
    let f = func (a int32) int32 {
        return a
    }
    if true {
        let g = func () int32 {
            return f(1, 2)
        }
`
        // A later local of the same name in the block is the one that the literal calls.
        const witness = `        let f = func (a int32, b int32) int32 {
            return a + b
        }
        let r = g()
    }
}
`
        let result = BindNothing(prefix, []string{witness})
        AssertWitness(prefix + witness, "GS0144")
        AssertFutureDependent(result, "GS0144", "later-declaration")
        let source = prefix + "/*CUT*/" + witness
        AssertFutureDependent(BindKeep(source), "GS0144", "later-declaration")
    }

    @Fact
    func ReportOutsideACallFrame_BaseConstructor_CanBeALaterConstructor() {
        const prefix = `package P

partial open class Base {
    init(a int32) {
    }
}

class Derived : Base {
    init() : base() {
    }
}
`
        const witness = `
partial open class Base {
    init() {
    }
}
`
        let result = BindNothing(prefix, []string{"", witness})
        AssertWitness(prefix + witness, "GS0214")
        AssertFutureDependent(result, "GS0214", "later-declaration")
    }

    @Fact
    func StaticAndBaseCalls_WrongArguments_CanBeALaterMember() {
        const staticPrefix = `package P

partial class Util {
    shared {
        func Twice(a int32) int32 {
            return a * 2
        }
    }
}

func Main() {
    let x = Util.Twice()
`
        const staticWitness = `}

partial class Util {
    shared {
        func Twice() int32 {
            return 0
        }
    }
}
`
        let staticResult = BindNothing(staticPrefix, []string{"}\n", staticWitness})
        AssertWitness(staticPrefix + staticWitness, "GS0144")
        AssertFutureDependent(staticResult, "GS0144", "later-member")
        const basePrefix = `package P

partial open class Base {
    open func Run(a int32) {
    }
}

class Derived : Base {
    override func Run(a int32) {
        base.Run()
    }
`
        const baseWitness = `}

partial open class Base {
    func Run() {
    }
}
`
        let baseResult = BindNothing(basePrefix, []string{"}\n", baseWitness})
        AssertWitness(basePrefix + baseWitness, "GS0144")
        AssertFutureDependent(baseResult, "GS0144", "later-member")
    }

    @Fact
    func MemberCallInTopLevelStatements_IsFinalWhenTheDeclarationsAreKept() {
        const source = `package P

class Box {
    func Put(v int32) {
    }
}

let b = Box()
b.Put()
/*CUT*/
let c = 1
`
        let keep = Assert.Single(BindKeep(source).Diagnostics)
        Assert.Equal("GS0144", keep.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.Final, keep.Finality)
    }

    @Fact
    func UndefinedUnaryOperator_CanBeALaterReceiverOperator() {
        const prefix = `package P

class V {
    var X int32
}

func Main() {
    let a = V()
    let b = -a
`
        const witness = `}

func (a V) operator - () V {
    return a
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0128")
        AssertFutureDependent(result, "GS0128", "later-member")
    }

    @Fact
    func MissingImplicitConversion_DependsOnTheTypes() {
        const prefix = `package P

open class Animal {
}

class Dog : Animal {
}

func Main() {
    let a Animal = Dog()
    let d Dog = a
`
        // An explicit conversion exists, so the report is the implicit form. Both types are of this package.
        AssertFutureDependent(BindNothing(prefix, []string{"}\n"}), "GS0156", "later-declaration")
        const builtin = "package P\n\nfunc Main() {\n    let big int64 = 5\n    let small int32 = big\n"
        let final = BindNothing(builtin, []string{"}\n"})
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(final.Diagnostics).Finality)
    }

    @Fact
    func GotoInAnOpenStaticInitializerOrAnonymousMethod_CanBeALaterLabel() {
        let prefixes = []string{
            "package P\n\nclass Holder {\n    shared {\n        init {\n            goto done\n",
            "package P\n\nfunc Main() {\n    let o = object {\n        func Run() {\n            goto done\n"
        }
        let witnesses = []string{
            "            done:\n            var x = 1\n        }\n    }\n}\n",
            "            done:\n            var x = 1\n        }\n    }\n}\n"
        }
        for var i = 0; i < prefixes.Length; i++ {
            let result = BindNothing(prefixes[i], []string{witnesses[i]})
            AssertWitness(prefixes[i] + witnesses[i], "GS0469")
            AssertFutureDependent(result, "GS0469", "rest-of-body")
        }
    }

    @Fact
    func OpenSwitchExpressionWithoutArms_CanGetTheArms() {
        const prefix = "package P\n\nfunc Name(v int32) string {\n    let s = switch v {\n"
        const witness = "        default: \"x\"\n    }\n    return s\n}\n"
        let result = BindNothing(prefix, []string{witness})
        AssertWitness(prefix + witness, "GS0176")
        AssertFutureDependent(result, "GS0176", "rest-of-statement")
    }

    @Fact
    func ArmTypeMismatchOfAClosedSwitchExpression_CanBeALaterConversion() {
        const prefix = `package P

struct V {
    var Value int32
}

func Pick(n int32) int32 {
    let r = switch n {
        case 0: 1
        default: V{Value: 2}
    }
    return r
}
`
        const witness = `
func operator implicit (v V) int32 {
    return v.Value
}
`
        let result = BindNothing(prefix, []string{"", witness})
        AssertWitness(prefix + witness, "GS0179")
        AssertFutureDependent(result, "GS0179", "later-declaration")
    }

    @Fact
    func MissingConversionToAnImportedType_CanBeALaterHidingType() {
        const prefix = `package P

import System

func Main() {
    let v Version = "s"
`
        // A later source type hides the imported one, and a later conversion converts to it.
        const witness = `}

class Version {
}

func operator implicit (s string) Version {
    return Version()
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-declaration")
    }

    @Fact
    func ConstraintFailureOfACall_CanBeALaterOverload() {
        const prefix = `package P

func Pick[T class](v T) {
}

func Main() {
    Pick[int32](1)
`
        const witness = `}

func Pick[T](v int32) {
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0152")
        AssertFutureDependent(result, "GS0152", "later-declaration")
    }

    @Fact
    func DiagnosticOfAnExpressionThatEndsAtTheCut_CanBeAPostfixContinuation() {
        const prefix = "package P\n\nfunc Main() {\n    let n int32 = \"s\""
        // A member access on the same or the next line continues the expression.
        let result = BindNothing(prefix, []string{".Length\n}\n", "\n        .Length\n}\n"})
        AssertWitness(prefix + ".Length\n}\n", "GS0155")
        AssertFutureDependent(result, "GS0155", "rest-of-statement")
        // With kept text, only a host text that continues the expression keeps the report open.
        AssertFutureDependent(BindKeep(prefix + "/*CUT*/\n        .Length\n}\n"), "GS0155", "rest-of-statement")
        let closed = BindKeep(prefix + "/*CUT*/\n    let m = 1\n}\n").Diagnostics.Single(
            (d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155"
        )
        Assert.Equal(DiagnosticFinality.Final, closed.Finality)
    }

    @Fact
    func MissingConversionToAnAnnotatedImportedType_IsFutureDependent() {
        const prefix = `package P

import System.Collections.Generic

func Main() {
    let xs List[string?] = "s"
    let n = 1
`
        AssertFutureDependent(BindNothing(prefix, []string{"}\n"}), "GS0155", "later-declaration")
    }

    // #6179: a call that resolves before the cut can resolve to a later, better overload. The type of its
    // result then changes, and so does each diagnostic of an expression that uses the result.
    @Fact
    func ResolvedCall_ALaterBetterOverloadChangesItsResult() {
        const prefix = `package P

func F(o object) string {
    return ""
}

func Main() {
    let x int32 = F(1)
    let done = 0
`
        const witness = `}

func F(i int32) int32 {
    return i
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
        // Every later declaration is present.
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(BindKeep(prefix + "/*CUT*/}\n").Diagnostics).Finality)
    }

    @Fact
    func ResolvedCall_TheChangedResultFlowsThroughAnInferredLocal() {
        const prefix = `package P

func G(o object) int32 {
    return 0
}

func Main() {
    let y = G(1)
    let x string = y
    let z = y
    let w string = z
    let done = 0
`
        const witness = `}

func G(i int32) string {
    return ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        Assert.Equal(2, result.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155"))
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ResolvedCall_GenericAndDefaultArgumentCandidatesCanBeBeaten() {
        const prefix = `package P

func G[T](v T) T {
    return v
}

func H(i int32, j int32 = 0) int32 {
    return 0
}

func Main() {
    let x string = G(1)
    let y string = H(1)
    let done = 0
`
        const witness = `}

func G(i int32) string {
    return ""
}

func H(i int32) string {
    return ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        Assert.Equal(2, result.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155"))
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ResolvedCall_TheChangedResultFlowsThroughLoopDeconstructionAndPatternVariables() {
        const prefix = `package P

func G(o object) []int32 {
    return []int32{1}
}

func H(o object) (int32, int32) {
    return (1, 2)
}

func Main() {
    for c in G(1) {
        let s string = c
    }
    let (p, q) = H(1)
    let t string = p
    if G(1) is {} v {
        let u string = v[0]
    }
    let done = 0
`
        const witness = `}

func G(i int32) []string {
    return []string{""}
}

func H(i int32) (string, string) {
    return ("", "")
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        Assert.Equal(3, result.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155"))
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ResolvedCall_TheChangedResultFlowsThroughAGlobalReadInAnotherBody() {
        const prefix = `package P

let g = G(1)

func G(o object) int32 {
    return 0
}

func Use() {
    let x string = g
    let done = 0
`
        const witness = `}

func G(i int32) string {
    return ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ResolvedIndexer_ALaterPartCanAddABetterIndexer() {
        const prefix = `package P

partial class B {
    prop this[o object] int32 {
        get {
            return 0
        }
    }
}

func Main() {
    let b = B()
    let s string = b[0]
    let done = 0
`
        const witness = `}

partial class B {
    prop this[i int32] string {
        get {
            return ""
        }
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ResolvedBaseCall_ALaterPartOfThePartialBaseCanBeBetter() {
        const prefix = `package P

open partial class Base {
    func F(o object) string {
        return ""
    }
}

class D : Base {
    func M() {
        let x int32 = base.F(1)
        let done = 0
`
        const witness = `    }
}

partial class Base {
    func F(i int32) int32 {
        return i
    }
}
`
        let result = BindNothing(prefix, []string{"    }\n}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ExactCallInAFunctionLiteral_ALaterLocalCanHideTheCallee() {
        const prefix = `package P

func F(i int32) int32 {
    return i
}

func Main() {
    let g = func () {
        let x string = F(1)
    }
`
        // A later local of the same name hides the function in the literal, whatever the match: the call
        // becomes ambiguous (GS0266), and the conversion report goes away.
        const witness = `    let F = func (i int32) string {
        return ""
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
        AssertFutureDependent(BindKeep(prefix + "/*CUT*/" + witness), "GS0155", "later-overload")
    }

    @Fact
    func CallOfAFunctionValueThatACallInfers_ChangesWithThatCall() {
        const prefix = `package P

func G(o object) () -> int32 {
    return () -> 0
}

func Main() {
    let f = G(1)
    let x string = f()
    let y = f(2)
    let done = 0
`
        const witness = `}

func G(i int32) () -> string {
    return () -> ""
}

func G(s string) (int32) -> string {
    return (v int32) -> ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
        // The arguments of the value's call can change too.
        Assert.All(
            result.Diagnostics,
            (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.FutureDependent, d.Finality)
        )
    }

    @Fact
    func StaticCallThroughAPartialDerivedType_ALaterPartCanHideTheInheritedMember() {
        const prefix = `package P

open class Base {
    shared {
        func F(o object) int32 {
            return 0
        }
    }
}

partial class Derived : Base {
}

func Main() {
    let x string = Derived.F(1)
    let done = 0
`
        const witness = `}

partial class Derived {
    shared {
        func F(i int32) string {
            return ""
        }
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ImportedMemberInheritedByAPartialType_ALaterPartCanBeBetter() {
        const prefix = `package P

partial class Box {
}

func Main() {
    let x string = Box().Equals(1)
    let done = 0
`
        const witness = `}

partial class Box {
    func Equals(i int32) string {
        return ""
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func DeconstructionOfAResultThatCanChange_IsFutureDependentAtThePattern() {
        const prefix = `package P

func G(o object) (int32, int32, int32) {
    return (1, 2, 3)
}

func Main() {
    let (a, b) = G(1)
    let done = 0
`
        const witness = `}

func G(i int32) (int32, int32) {
    return (1, 2)
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0163")
        AssertFutureDependent(result, "GS0163", "later-overload")
    }

    @Fact
    func IndexerInheritedFromAClosedBase_ALaterPartOfThePartialTypeCanBeBetter() {
        const prefix = `package P

open class Base[T] {
    prop this[o object] T {
        get {
            return default(T)
        }
    }
}

partial class Box : Base[int32] {
}

func Main() {
    let x string = Box()[0]
    let done = 0
`
        const witness = `}

partial class Box {
    prop this[i int32] string {
        get {
            return ""
        }
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ClrIndexerInheritedByAPartialType_ALaterPartCanBeBetter() {
        const prefix = `package P

import System.Collections.Generic

partial class Box : Dictionary[object, int32] {
}

func Main() {
    let x string = Box()[0]
    let done = 0
`
        const witness = `}

partial class Box {
    prop this[i int32] string {
        get {
            return ""
        }
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func IndexArgumentConversion_CanBeALaterIndexer() {
        const prefix = `package P

partial class B {
    prop this[s string] int32 {
        get {
            return 0
        }
    }
}

func Main() {
    let b = B()
    let x = b[1]
    let done = 0
`
        const witness = `}

partial class B {
    prop this[i int32] int32 {
        get {
            return i
        }
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0154")
        // The argument check of an indexer has the premise of a call without a frame.
        Assert.Equal(
            DiagnosticFinality.FutureDependent,
            result.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0154").Finality
        )
    }

    @Fact
    func ClrDelegateThatACallInfers_ChangesWithThatCall() {
        const prefix = `package P

import System

func G(o object) Func[int32] {
    return () -> 0
}

func Main() {
    let f = G(1)
    let x string = f()
    let done = 0
`
        const witness = `}

func G(i int32) Func[string] {
    return () -> ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func PackageFunctionInAPartialType_ALaterMemberCanHideIt() {
        const prefix = `package P

func F(i int32) int32 {
    return i
}

partial class C {
    func M() {
        let x string = F(1)
        let done = 0
    }
}
`
        const witness = `
partial class C {
    func F(i int32) string {
        return ""
    }
}
`
        let result = BindNothing(prefix, []string{"\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func MemberFoundThroughAPartialIntermediateType_ALaterMemberCanHideIt() {
        const prefix = `package P

open class Root {
    func F(o object) int32 {
        return 0
    }
}

open partial class Middle : Root {
}

class Leaf : Middle {
}

func Main() {
    let x string = Leaf().F(1)
    let done = 0
`
        const witness = `}

partial class Middle {
    func F(i int32) string {
        return ""
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func PatternOfAResultThatCanChange_IsFutureDependent() {
        const prefix = `package P

func G(o object) int32 {
    return 0
}

func Main() {
    if G(1) is [1] {
    }
    let done = 0
`
        const witness = `}

func G(i int32) []int32 {
    return []int32{1}
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0175")
        AssertFutureDependent(result, "GS0175", "later-overload")
    }

    @Fact
    func MemberFoundThroughATypeParameterConstraint_ALaterMemberCanHideIt() {
        const prefix = `package P

open class Root {
    func F(o object) int32 {
        return 0
    }
}

open partial class Middle : Root {
}

func Use[T Middle](v T) {
    let x string = v.F(1)
    let done = 0
`
        const witness = `}

partial class Middle {
    func F(i int32) string {
        return ""
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func AssignmentToALocalThatACallTypes_ChangesWithThatCall() {
        const prefix = `package P

func G(o object) int32 {
    return 0
}

func Main() {
    var y = G(1)
    y = ""
    let done = 0
`
        const witness = `}

func G(i int32) string {
    return ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ObsoleteCandidate_CanBeALaterBetterOverload() {
        const prefix = `package P

@Obsolete("use the other")
func F(o object) int32 {
    return 0
}

func Main() {
    let x = F(1)
    let done = 0
`
        const witness = `}

func F(i int32) int32 {
    return i
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0204")
        AssertFutureDependent(result, "GS0204", "later-overload")
    }

    @Fact
    func NarrowedReadOfALocalThatACallTypes_ChangesWithThatCall() {
        const prefix = `package P

func G(o object) int32? {
    return 0
}

func Main() {
    let v = G(1)
    if v != nil {
        let s string = v
    }
    let done = 0
`
        const witness = `}

func G(i int32) string? {
    return ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func AwaitOfAnAsyncLetThatACallTypes_ChangesWithThatCall() {
        const prefix = `package P

func G(o object) int32 {
    return 0
}

func Main() {
    scope {
        async let y = G(1)
        let s string = await y
        let done = 0
`
        const witness = `    }
}

func G(i int32) string {
    return ""
}
`
        let result = BindNothing(prefix, []string{"    }\n}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ImportedExtensionCall_ALaterReceiverFunctionCanBeBetter() {
        const prefix = `package P

import System.Linq

func Main() {
    let xs = []int32{1}
    let s string = xs.Count()
    let done = 0
`
        const witness = `}

func (xs []int32) Count() string {
    return ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ImportedMemberWithAFunctionLiteral_ALaterReceiverFunctionCanBeBetter() {
        const prefix = `package P

import System.Collections.Generic

func Main() {
    let v = List[int32]().ForEach((i int32) -> i + 1)
    let done = 0
`
        const witness = `}

func (l List[int32]) ForEach(f (int32) -> int32) int32 {
    return 0
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0124")
        AssertFutureDependent(result, "GS0124", "later-overload")
    }

    @Fact
    func ReceiverDeconstructOfAPartialType_ALaterMemberCanBeBetter() {
        const prefix = `package P

partial class Box {
}

func (b Box) Deconstruct(out p int32, out q int32) {
    p = 0
    q = 0
}

func Main() {
    let (p, q) = Box()
    let s string = p
    let done = 0
`
        const witness = `}

partial class Box {
    func Deconstruct(out p string, out q string) {
        p = ""
        q = ""
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func InheritedPropertyOfAPartialType_ALaterPartCanHideIt() {
        const prefix = `package P

open class Base {
    prop Size int32 -> 1
}

partial class Box : Base {
}

func Main() {
    let s string = Box().Size
    let done = 0
`
        const witness = `}

partial class Box {
    prop Size string -> ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func PatternInAFieldInitializer_IsFutureDependent() {
        const prefix = `package P

func G(o object) int32 {
    return 0
}

class C {
    let ok bool = G(1) is [1]
}

func Main() {
    let done = 0
`
        const witness = `}

func G(i int32) []int32 {
    return []int32{1}
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0175")
        AssertFutureDependent(result, "GS0175", "later-overload")
    }

    @Fact
    func LongAliasChainOfANarrowedRead_IsFutureDependent() {
        const prefix = `package P

func G(o object) int32? {
    return 0
}

func Main() {
    let v = G(1)
    if v != nil {
        let a = v
        let b = a
        let c = b
        let d = c
        let e = d
        let f = e
        let s string = f
    }
    let done = 0
`
        const witness = `}

func G(i int32) string? {
    return ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func WriteToAGlobalOfAnotherTree_IsFutureDependent() {
        const cutTree = "package P\n\nfunc G(o object) int32 {\n    return 0\n}\n\nvar y = G(1)\nlet done = 0\n"
        const other = "package P\n\nfunc Use() {\n    y = \"\"\n}\n"
        let otherTree = SyntaxTree.Parse(SourceText.From(other, "other.gs"))
        let tree = SyntaxTree.Parse(SourceText.From(cutTree, "prefix.gs"))
        let result = Compilation(tree, otherTree).BindPrefix(
            tree,
            cutTree.Length,
            PrefixBindOptions(PrefixRemainder.Nothing, includeScope: false)
        )
        let completed = SyntaxTree.Parse(
            SourceText.From(cutTree + "\nfunc G(i int32) string {\n    return \"\"\n}\n", "prefix.gs")
        )
        Assert.DoesNotContain(
            Compilation(completed, SyntaxTree.Parse(SourceText.From(other, "other.gs"))).GetDiagnostics(),
            (d Diagnostic) -> d.Id == "GS0155"
        )
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func TypeImportedStaticCall_ALaterTopLevelGlobalCanHideIt() {
        const source = `package P

import System.Math

func Use() {
    let x string = Abs(1)
}

let before = 0
/*CUT*/
let Abs = func (i int32) string {
    return ""
}
`
        AssertWitness(source.Replace("/*CUT*/", string.Empty), "GS0155")
        AssertFutureDependent(BindKeep(source), "GS0155", "later-overload")
    }

    @Fact
    func InheritedStaticPropertyThroughAPartialType_ALaterPartCanHideIt() {
        const prefix = `package P

open class Base {
    shared {
        prop Size int32 -> 1
    }
}

partial class Box : Base {
}

func Main() {
    let s string = Box.Size
    let done = 0
`
        const witness = `}

partial class Box {
    shared {
        prop Size string -> ""
    }
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    @Fact
    func ResolvedCall_AnExactNonGenericMatchCannotBeBeaten() {
        const prefix = `package P

func G(i int32) int32 {
    return 0
}

func Main() {
    let x string = G(1)
    let done = 0
`
        // A later overload with the same parameter types is a duplicate, and any other one converts worse.
        let result = BindNothing(
            prefix,
            []string{
                "}\n",
                "}\n\nfunc G(i int64) string {\n    return \"\"\n}\n",
                "}\n\nfunc G[T](v T) string {\n    return \"\"\n}\n"
            }
        )
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(result.Diagnostics).Finality)
    }

    @Fact
    func ResolvedCall_AVoidResultCanBecomeAValue() {
        const prefix = `package P

import System.Threading.Tasks

func V(o object) {
}

async func Main() {
    let x = V(1)
    await V(2)
    let done = 0
`
        const witness = `}

func V(i int32) Task {
    return Task.CompletedTask
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0124")
        Assert.Equal(2, result.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0124"))
        AssertFutureDependent(result, "GS0124", "later-overload")
    }

    @Fact
    func ResolvedCall_IndexForeachDeconstructionAndConditionUseItsResult() {
        const prefix = `package P

func G(o object) int32 {
    return 0
}

func Main() {
    let v = G(1)[0]
    for c in G(1) {
    }
    let (p, q) = G(1)
    if G(1) {
    }
    let done = 0
`
        const witness = `}

func G(i int32) []int32 {
    return []int32{1, 2}
}
`
        const tupleWitness = `}

func G(i int32) (int32, int32) {
    return (1, 2)
}
`
        let result = BindNothing(prefix, []string{"}\n", witness, tupleWitness})
        AssertWitness(prefix + witness, "GS0116")
        AssertWitness(prefix + tupleWitness, "GS0164")
        Assert.Equal(2, result.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0116"))
        for d in result.Diagnostics {
            Assert.Equal(DiagnosticFinality.FutureDependent, d.Finality)
        }
        let condition = result.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155")
        Assert.Equal("later-overload", condition.Reason)
    }

    @Fact
    func ResolvedMemberCall_DependsOnWhetherALaterMemberCanBeBetter() {
        const prefix = `package P

import System.Text

partial class Box {
    func Put(o object) int32 {
        return 0
    }
}

class Closed {
    func Put(o object) int32 {
        return 0
    }
}

func (sb StringBuilder) Count(o object) int32 {
    return 0
}

func Main() {
    let x string = Box().Put(1)
    let y string = StringBuilder().Count(1)
    let z string = Closed().Put(1)
    let done = 0
`
        // A later part of a partial type and a later receiver function can be better. A receiver function
        // does not beat an instance member of a closed type.
        const witness = `}

partial class Box {
    func Put(i int32) string {
        return ""
    }
}

func (sb StringBuilder) Count(i int32) string {
    return ""
}

func (c Closed) Put(i int32) string {
    return ""
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        let reported = Diagnose(prefix + witness).Where((d Diagnostic) -> d.Id == "GS0155").ToList()
        let removable = result
            .Diagnostics
            .Where(
            (d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155" && !reported.Any(
                (r Diagnostic) -> Key(r) == Key(d.Diagnostic)
            )
        )
            .ToList()
        Assert.Equal(2, removable.Count)
        Assert.All(removable, (d ClassifiedDiagnostic) -> Assert.Equal("later-overload", d.Reason))
        let kept = Assert.Single(reported)
        Assert.Equal(
            DiagnosticFinality.Final,
            result.Diagnostics.Single((d ClassifiedDiagnostic) -> Key(d.Diagnostic) == Key(kept)).Finality
        )
    }

    @Fact
    func MissingIndexerEnumeratorOrDeconstruct_CanBeALaterMember() {
        const prefix = `package P

import System.Text

partial class Box {
}

func Main() {
    let b = Box()
    let v = b[0]
    for c in b {
    }
    let (p, q) = b
    let (r, s) = StringBuilder()
    let done = 0
`
        const witness = `}

partial class Box {
    prop this[i int32] int32 {
        get {
            return i
        }
    }

    func GetEnumerator() System.Collections.Generic.IEnumerator[int32] {
        return System.Collections.Generic.List[int32]().GetEnumerator()
    }

    func Deconstruct(out p int32, out q int32) {
        p = 0
        q = 0
    }
}

func (sb StringBuilder) Deconstruct(out p int32, out q int32) {
    p = 0
    q = 0
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0116", "GS0164")
        Assert.Equal(2, result.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0116"))
        Assert.Equal(2, result.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0164"))
        // A later member can declare what the lookup misses; the lookup is also of a type that can get members.
        for d in result.Diagnostics.Where(
            (d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0116" || d.Diagnostic.Id == "GS0164"
        ) {
            Assert.Equal(DiagnosticFinality.FutureDependent, d.Finality)
            Assert.Contains(d.Reason, []string{"later-member", "later-overload"})
        }
        // Every later member is present.
        for d in BindKeep(prefix + "/*CUT*/}\n").Diagnostics {
            Assert.Equal(DiagnosticFinality.Final, d.Finality)
        }
    }

    // #6229 Hole 1: a report inside a lambda or nested statement whose type comes from an enclosing call
    // or labeled/multi-assignment header follows the enclosing provisional expression, while unrelated
    // statements inside compound blocks or literals stay final.
    @Fact
    func ReportInsideLambdaArgumentOfProvisionalChain_IsFutureDependentInKeepDeclarations() {
        const applySource = `package P

class BoxInt {
    func Apply(f (int32) -> void) {
    }
}

class BoxStr {
    func Apply(f (string) -> void) {
    }
}

func G(o object) BoxInt {
    return BoxInt()
}

func Main() {
    let outer = func () {
        G(1).Apply((x) -> {
            let s string = x
        })
    }
/*CUT*/
    let G = func (i int32) BoxStr {
        return BoxStr()
    }
}
`
        let complete = Diagnose(applySource.Replace("/*CUT*/", string.Empty))
        Assert.True(complete.Length == 0, string.Join("; ", complete.Select((d Diagnostic) -> d.ToString())))
        AssertFutureDependent(BindKeep(applySource), "GS0155", "later-overload")

        const runSource = `package P

class BoxInt {
    func Run(f () -> int32) {
    }
}

class BoxStr {
    func Run(f () -> string) {
    }
}

func G(o object) BoxInt {
    return BoxInt()
}

func Main() {
    let outer = func () {
        G(1).Run(() -> {
            if true {
                return "s"
            }
            return ""
        })
    }
/*CUT*/
    let G = func (i int32) BoxStr {
        return BoxStr()
    }
}
`
        AssertWitness(runSource.Replace("/*CUT*/", string.Empty), "GS0155")
        AssertFutureDependent(BindKeep(runSource), "GS0155", "later-overload")

        // Negative controls: a fixed call without provisional expressions, an unrelated statement inside an
        // `if` with a provisional condition, and an unrelated statement in a function literal stay Final.
        const fixedControl = `package P

class Closed {
    func Run(a int32, f () -> int32) {
    }
}

func Main() {
    Closed().Run(1, () -> {
        return "s"
    })
/*CUT*/
}
`
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(BindKeep(fixedControl).Diagnostics).Finality)

        const compoundControl = `package P

func G(o object) int32 {
    return 0
}

func Main() {
    if G(1) == 0 {
        let x int32 = "s"
    }
    let outer = func () {
        let a = G(1)
        let y int32 = "s"
    }
    let done = 0
`
        let nothingControls = BindNothing(compoundControl, []string{"}\n"})
        let mismatches = nothingControls
            .Diagnostics
            .Where((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155")
            .ToList()
        Assert.Equal(2, mismatches.Count)
        Assert.All(mismatches, (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.Final, d.Finality))
    }

    @Fact
    func LabeledAndMultiAssignmentHeaders_PropagateProvisionalVariableReads() {
        const prefix = `package P

class BoxInt {
    var Val int32
}

class BoxStr {
    var Val string = ""
}

func G(o object) int32 {
    return 0
}

func H(o object) (int32, int32) {
    return (1, 2)
}

func A(o object) []int32 {
    return []int32{1}
}

func B(o object) BoxInt {
    return BoxInt()
}

func Main() {
done:
    let y = G(1)
    let s1 string = y
    var a object = 0
    a, let fresh = H(1)
    let s2 string = fresh
    let arr = A(1)
    arr[0] = ""
    let bx = B(1)
    bx.Val = ""
    let done = 0
`
        const witness = `}

func G(i int32) string {
    return ""
}

func H(i int32) (string, string) {
    return ("", "")
}

func A(i int32) []string {
    return []string{""}
}

func B(i int32) BoxStr {
    return BoxStr()
}
`
        let result = BindNothing(prefix, []string{"}\n", witness})
        AssertWitness(prefix + witness, "GS0155")
        Assert.Equal(4, result.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155"))
        AssertFutureDependent(result, "GS0155", "later-overload")
    }

    // #6229 Hole 2: in KeepDeclarations with the cut in top-level statements, a later top-level global
    // shadows non-package simple names inside member/function bodies, but not package functions,
    // locals/parameters, enclosing fields, qualified accesses, field initializers, or earlier top-level
    // statements.
    @Fact
    func KeepDeclarations_LaterTopLevelGlobalShadowsNonPackageSimpleNames() {
        const source = `package P

import System
import System.Math
import System.Text

class Box {
    init(i int32) {
    }
}

open class Base {
    func BaseM(i int32) int32 {
        return i
    }

    shared {
        func BaseStatic(i int32) int32 {
            return i
        }
    }
}

class Derived : Base {
    func Inst(i int32) int32 {
        return i
    }

    shared {
        func Stat(i int32) int32 {
            return i
        }
    }

    func M() {
        let a string = Box(1)
        let b string = StringBuilder(16)
        let c string = int32(1)
        let d string = Inst(1)
        let e string = Stat(1)
        let f string = BaseM(1)
        let g string = BaseStatic(1)
        let h string = PI
        let j (int32) -> string = Abs
    }
}

class MyEx : Exception {
    func M() {
        let m string = HResult
    }
}

let before = 0
/*CUT*/
let Box = func (i int32) string {
    return ""
}
let StringBuilder = func (n int32) string {
    return ""
}
let int32 = func (i int32) string {
    return ""
}
let Inst = func (i int32) string {
    return ""
}
let Stat = func (i int32) string {
    return ""
}
let BaseM = func (i int32) string {
    return ""
}
let BaseStatic = func (i int32) string {
    return ""
}
let PI = ""
let Abs = func (i int32) string {
    return ""
}
let HResult = ""
`
        AssertWitness(source.Replace("/*CUT*/", string.Empty), "GS0155", "GS0218")
        let keep = BindKeep(source)
        Assert.True(
            keep.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155") == 9,
            string.Join("; ", keep.Diagnostics.Select((d ClassifiedDiagnostic) -> d.ToString()))
        )
        Assert.Equal(1, keep.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0218"))
        AssertFutureDependent(keep, "GS0155", "later-overload")
        AssertFutureDependent(keep, "GS0218", "later-overload")
    }

    @Fact
    func KeepDeclarations_LaterTopLevelGlobalDoesNotShadowPackageFunctionsLocalsQualifiersOrSequentialTopLevel() {
        const source = `package P

import System
import System.Math

func Helper(i int32) int32 {
    return i
}

class Box {
    init(i int32) {
    }

    shared {
        let Val int32 = 1
    }
}

class Holder {
    func Abs(i int32) string {
        return ""
    }
}

class FieldOwner {
    let f string = Box(1)
}

class C {
    shared {
        let Encl int32 = 1
    }

    func M(p int32) {
        let l = 1
        let a string = Helper(1)
        let b (int32) -> string = Helper
        let c string = Encl
        let d string = p
        let e string = l
        let f string = Math.Abs(1)
        let g string = Box.Val
    }
}

let top1 string = Abs(1)
let top2 string = PI
let top3 string = Box(1)
/*CUT*/
let Helper = func (i int32) string {
    return ""
}
let Encl = ""
let p = ""
let l = ""
let Math = Holder()
let Box = func (i int32) string {
    return ""
}
let Abs = func (i int32) string {
    return ""
}
let PI = ""
`
        let complete = Diagnose(source.Replace("/*CUT*/", string.Empty)).Where((d Diagnostic) -> d.Id == "GS0155")
            .ToList()
        Assert.Equal(11, complete.Count)
        let keep = BindKeep(source)
        let keepMismatches = keep.Diagnostics.Where((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").ToList()
        Assert.Equal(11, keepMismatches.Count)
        Assert.All(keepMismatches, (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.Final, d.Finality))
    }

    @Fact
    func KeepDeclarations_FunctionLiteralMethodGroup_CanBeALaterLocal() {
        const source = `package P

func Helper(i int32) int32 {
    return i
}

func Main() {
    let g = func () {
        let f (int32) -> string = Helper
    }
/*CUT*/
    let Helper = func (i int32) string {
        return ""
    }
}
`
        AssertWitness(source.Replace("/*CUT*/", string.Empty), "GS0155")
        AssertFutureDependent(BindKeep(source), "GS0155", "later-overload")
    }

    // #6229 Hole 3: reports before a call is recorded (base call obsolete, KeepDeclarations obsolete,
    // ref/parenthesized arguments, and fixed-call named-argument parameter errors).
    @Fact
    func ReportsBeforeCallIsRecorded_BaseObsoleteKeepDeclarationsObsoleteAndRefArguments() {
        const basePrefix = `package P

partial open class Base {
    func F(o object) {
    }
}

class Derived : Base {
    func Use() {
        base.F[int32](1)
    }
`
        const baseWitness = `}

partial open class Base {
    func F[T](i int32) {
    }
}
`
        let baseResult = BindNothing(basePrefix, []string{"}\n", baseWitness})
        AssertWitness(basePrefix + baseWitness, "GS0148")
        AssertFutureDependent(baseResult, "GS0148", "later-member")

        const keepLiteralObsolete = `package P

@Obsolete("old")
func F(i int32) int32 {
    return i
}

func Main() {
    let g = func () {
        let x = F(1)
    }
/*CUT*/
    let F = func (i int32) int32 {
        return i
    }
}
`
        AssertWitness(keepLiteralObsolete.Replace("/*CUT*/", string.Empty), "GS0204")
        AssertFutureDependent(BindKeep(keepLiteralObsolete), "GS0204", "later-overload")

        const keepGlobalObsolete = `package P

import System

@Obsolete("old")
class Box {
    init(i int32) {
    }
}

func Use() {
    let x = Box(1)
}

let before = 0
/*CUT*/
let Box = func (i int32) int32 {
    return i
}
`
        AssertWitness(keepGlobalObsolete.Replace("/*CUT*/", string.Empty), "GS0204")
        AssertFutureDependent(BindKeep(keepGlobalObsolete), "GS0204", "later-overload")

        const refArgPrefix = `package P

func F(out s string) {
    s = ""
}

func Main() {
    var x = 0
    F(out x)
`
        const refArgWitness = `}

func F(out i int32) {
    i = 0
}
`
        let refResult = BindNothing(refArgPrefix, []string{"}\n", refArgWitness})
        AssertWitness(refArgPrefix + refArgWitness, "GS0154")
        AssertFutureDependent(refResult, "GS0154", "later-declaration")

        // Negative controls: obsolete package function in KeepDeclarations with top-level cut, and wrong
        // named argument on a local function value stay Final.
        const keepPackageObsolete = `package P

@Obsolete("old")
func Helper(i int32) int32 {
    return i
}

func Use() {
    let x = Helper(1)
}

let before = 0
/*CUT*/
let Helper = func (i int32) int32 {
    return i
}
`
        let helperKeep = BindKeep(keepPackageObsolete)
        Assert.Equal(
            DiagnosticFinality.Final,
            helperKeep.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0204").Finality
        )

        const fixedNamedPrefix = `package P

func Main() {
    let f = func (a int32) int32 {
        return a
    }
    let x = f(bad: 1)
    let done = 0
`
        let fixedNamedResult = BindNothing(fixedNamedPrefix, []string{"}\n"})
        Assert.Equal(
            DiagnosticFinality.Final,
            fixedNamedResult.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0246").Finality
        )
    }

    // #6229 Hole 4: collection initializers, nameof, interpolation holes, and pattern operands.
    @Fact
    func ExpressionsWithoutARecordingBinder_WitnessesAndControls() {
        const collMissingPrefix = `package P

partial class Coll {
}

func Main() {
    let c = Coll(){ 1 }
    let done = 0
`
        const collMissingWitness = `}

partial class Coll {
    func Add(i int32) {
    }
}
`
        let collMissingResult = BindNothing(collMissingPrefix, []string{"}\n", collMissingWitness})
        AssertWitness(collMissingPrefix + collMissingWitness, "GS0369")
        AssertFutureDependent(collMissingResult, "GS0369", "later-member")

        const collIndexPrefix = `package P

partial class Coll {
    prop this[s string] int32 {
        get {
            return 0
        }
        set {
        }
    }

    func Add(i int32) {
    }
}

func Main() {
    let c1 = Coll(){ [0] = 1 }
    c1[0] = 1
    let done = 0
`
        const collIndexWitness = `}

partial class Coll {
    prop this[i int32] int32 {
        get {
            return 0
        }
        set {
        }
    }
}
`
        let collIndexResult = BindNothing(collIndexPrefix, []string{"}\n", collIndexWitness})
        AssertWitness(collIndexPrefix + collIndexWitness, "GS0155")
        Assert.Equal(2, collIndexResult.Diagnostics.Count((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155"))
        AssertFutureDependent(collIndexResult, "GS0155", "later-overload")

        const propPatternPrefix = `package P

partial class Box {
    prop X int32 -> 1
}

func Main(b Box) {
    if b is { Missing: 1 } {
    }
    let done = 0
`
        const propPatternWitness = `}

partial class Box {
    prop Missing int32 -> 1
}
`
        let propPatternResult = BindNothing(propPatternPrefix, []string{"}\n", propPatternWitness})
        AssertWitness(propPatternPrefix + propPatternWitness, "GS0173")
        AssertFutureDependent(propPatternResult, "GS0173", "later-member")

        const eqPatternPrefix = `package P

struct S {
    var V int32
}

func Main(s S) {
    if s is == s {
    }
    let done = 0
`
        const eqPatternWitness = `}

func (a S) operator == (b S) bool {
    return true
}
`
        let eqPatternResult = BindNothing(eqPatternPrefix, []string{"}\n", eqPatternWitness})
        AssertWitness(eqPatternPrefix + eqPatternWitness, "GS0174")
        AssertFutureDependent(eqPatternResult, "GS0174", "later-member")

        const interpHolePrefix = `package P

func G(o object) int32 {
    return 0
}

func Main() {
    let f = func (s string) string {
        return s
    }
    let s = "v=${f(G(1))}"
    let done = 0
`
        const interpHoleWitness = `}

func G(i int32) string {
    return ""
}
`
        let interpHoleResult = BindNothing(interpHolePrefix, []string{"}\n", interpHoleWitness})
        AssertWitness(interpHolePrefix + interpHoleWitness, "GS0155")
        AssertFutureDependent(interpHoleResult, "GS0155", "later-overload")

        // Negative controls that must stay Final: nameof (even with member access), interpolation outer
        // type (even with a provisional call or variable in a hole), closed collection initializer, closed
        // object creation with initializer member access, closed property pattern, and relational `<`
        // pattern on a struct.
        const controlsPrefix = `package P

import System

class ClosedBox {
    var X int32
}

struct S {
    var V int32
}

func G(o object) int32 {
    return 0
}

func Main(cb ClosedBox, s S) {
    let n1 int32 = nameof(System.Math.PI)
    let n2 int32 = nameof(cb.X)
    let i1 int32 = "v=${G(1)}"
    let x = G(1)
    let i1b int32 = "v=${x}"
    let held = "v=${G(1)}"
    let i2 int32 = held
    let c1 = ClosedBox(){ 1 }
    let o1 string = ClosedBox(){ X = 1 }.X
    if cb is { Missing: 1 } {
    }
    if s is < s {
    }
    let done = 0
`
        let controlsResult = BindNothing(controlsPrefix, []string{"}\n"})
        Assert.True(
            controlsResult.Diagnostics.Length == 9,
            string.Join("; ", controlsResult.Diagnostics.Select((d ClassifiedDiagnostic) -> d.ToString()))
        )
        Assert.All(
            controlsResult.Diagnostics,
            (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.Final, d.Finality)
        )
    }

    // #6229 review follow-ups: fallback lookup shadowing premise (GS0472), fixed outer call excluding
    // its own lambda body's provisional calls, nested interpolation shielding, handler-targeted
    // interpolation hole dependencies (GS0221), and inline out var inside an interpolation hole.
    @Fact
    func ReviewFollowUps_ShadowedFallbackLambdaExclusionNestedAndHandlerInterpolationAndInlineOut() {
        // 1. Type-imported private static read in a package function is shadowed by a later top-level global.
        const privateStaticSource = `package P

import P.Holder

class Holder {
    shared {
        private let Secret int32 = 42
    }
}

func Use() int32 {
    return Secret
}

let before = 0
/*CUT*/
let Secret int32 = 1
`
        AssertWitness(privateStaticSource.Replace("/*CUT*/", string.Empty), "GS0472")
        AssertFutureDependent(BindKeep(privateStaticSource), "GS0472", "later-overload")

        // 2. A fixed call passing a lambda whose own body contains a provisional call keeps unrelated errors Final.
        const fixedLambdaControl = `package P

class Closed {
    func Run(f () -> void) {
    }
}

func G(o object) int32 {
    return 0
}

func Main() {
    Closed().Run(() -> {
        let a = G(1)
        let bad int32 = "s"
    })
/*CUT*/
    let G = func (i int32) string {
        return ""
    }
}
`
        let fixedLambdaKeep = BindKeep(fixedLambdaControl)
        Assert.Equal(
            DiagnosticFinality.Final,
            fixedLambdaKeep.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Finality
        )

        // 3. A nested interpolation inside an outer interpolation still shields its own conversion to int32.
        const nestedInterpPrefix = `package P

func G(o object) int32 {
    return 0
}

func TakeInt(i int32) int32 {
    return i
}

func Main() {
    let f = func (i int32) int32 {
        return i
    }
    let s = "outer=${f("inner=${G(1)}")}"
    let done = 0
`
        let nestedResult = BindNothing(nestedInterpPrefix, []string{"}\n"})
        Assert.Equal(
            DiagnosticFinality.Final,
            nestedResult.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Finality
        )

        // 4. Handler-targeted interpolation depends on its holes (GS0221 becomes FutureDependent when a hole changes).
        const csharpHandler = `
using System.Runtime.CompilerServices;
namespace Handler6229 {
    [InterpolatedStringHandler]
    public struct StrOnlyHandler {
        public StrOnlyHandler(int literalLength, int formattedCount) {}
        public void AppendLiteral(string s) {}
        public void AppendFormatted(string s) {}
    }
    public static class Logger {
        public static void Log(StrOnlyHandler handler) {}
    }
}
`
        using let fixture = GSharp.Core.Tests.CSharpFixture(csharpHandler)
        using let references = fixture.RuntimeReferences()
        const handlerSource = `package P

import Handler6229

func Use() {
    Logger.Log("${int32(1)}")
}

let before = 0
/*CUT*/
let int32 = func (i int32) string {
    return ""
}
`
        let completeHandlerTree = SyntaxTree.Parse(
            SourceText.From(handlerSource.Replace("/*CUT*/", string.Empty), "handler.gs")
        )
        let completeHandlerDiags = Compilation(references, completeHandlerTree).GetDiagnostics()
        Assert.DoesNotContain("GS0221", completeHandlerDiags.Select((d Diagnostic) -> d.Id))
        let handlerCut = handlerSource.IndexOf("/*CUT*/", StringComparison.Ordinal)
        let handlerKeep = Compilation(references, completeHandlerTree).BindPrefix(
            completeHandlerTree,
            handlerCut,
            PrefixBindOptions(PrefixRemainder.KeepDeclarations, includeScope: false)
        )
        AssertFutureDependent(handlerKeep, "GS0221", "later-overload")

        // 5. Inline `out var` inside an interpolation hole propagates its provisional call type to later reads.
        const inlineOutPrefix = `package P

func F(o object, out v int32) bool {
    v = 0
    return true
}

func Main() {
    let text = "${F(1, out var x)}"
    let s string = x
    let done = 0
`
        const inlineOutWitness = `}

func F(i int32, out v string) bool {
    v = ""
    return true
}
`
        let inlineOutResult = BindNothing(inlineOutPrefix, []string{"}\n", inlineOutWitness})
        AssertWitness(inlineOutPrefix + inlineOutWitness, "GS0155")
        AssertFutureDependent(inlineOutResult, "GS0155", "later-overload")

        // 6. Multi-index assignment on a partial type records the hierarchy dependency.
        const multiIndexPrefix = `package P

partial class Coll {
    prop this[a object, b object] int32 {
        get {
            return 0
        }
        set {
        }
    }
}

func Main(c Coll) {
    c[1, 2] = ""
    let done = 0
`
        const multiIndexWitness = `}

partial class Coll {
    prop this[a int32, b int32] string {
        get {
            return ""
        }
        set {
        }
    }
}
`
        let multiIndexResult = BindNothing(multiIndexPrefix, []string{"}\n", multiIndexWitness})
        AssertWitness(multiIndexPrefix + multiIndexWitness, "GS0155")
        AssertFutureDependent(multiIndexResult, "GS0155", "later-overload")

        // 7. Two-argument fixed non-generic call excludes sibling lambda bodies, and 20 nested fixed calls
        // complete linearly without exponential recursion.
        const twoLambdaControl = `package P

class Closed {
    func Run(f () -> void, g () -> void) {
    }

    func RunExpr(f () -> int32, g () -> void) {
    }
}

func G(o object) int32 {
    return 0
}

func Main() {
    Closed().Run(() -> {
        let a = G(1)
    }, () -> {
        let bad int32 = "s"
    })
    Closed().RunExpr(() -> G(1), () -> {
        let bad2 int32 = "s"
    })
/*CUT*/
    let G = func (i int32) string {
        return ""
    }
}
`
        let twoLambdaKeep = BindKeep(twoLambdaControl)
        let twoLambdaErrors = twoLambdaKeep
            .Diagnostics
            .Where((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155")
            .ToList()
        Assert.Equal(2, twoLambdaErrors.Count)
        Assert.All(twoLambdaErrors, (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.Final, d.Finality))

        let nestedSb = System.Text.StringBuilder()
        nestedSb.AppendLine("package P")
        nestedSb.AppendLine("class Closed { func Run(f () -> void) {} }")
        nestedSb.AppendLine("func G(o object) int32 { return 0 }")
        nestedSb.AppendLine("func Main() {")
        for var depth = 0; depth < 20; depth++ {
            nestedSb.AppendLine("    Closed().Run(() -> {")
        }
        nestedSb.AppendLine("        let a = G(1)")
        nestedSb.AppendLine("        let bad int32 = \"s\"")
        for var depth = 0; depth < 20; depth++ {
            nestedSb.AppendLine("    })")
        }
        nestedSb.AppendLine("/*CUT*/")
        nestedSb.AppendLine("    let G = func (i int32) string { return \"\" }")
        nestedSb.AppendLine("}")
        let nestedKeep = BindKeep(nestedSb.ToString())
        Assert.Equal(
            DiagnosticFinality.Final,
            nestedKeep.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Finality
        )

        // 8. Negative controls verified with gsc 0.5.793: receiver-form `func (x int32) Secret()` prevents
        // top-level `let Secret` from shadowing `Holder.Secret` (GS0472 stays Final), and a local `let PI`
        // after `let f = func () { let s string = PI }` does not shadow `System.Math.PI` (GS0155 stays Final).
        const extSecretControl = `package P

import P.Holder

class Holder {
    shared {
        private let Secret int32 = 42
    }
}

func (x int32) Secret() int32 {
    return x
}

func Use() int32 {
    return Secret
}

let before = 0
/*CUT*/
let Secret int32 = 1
`
        let extSecretKeep = BindKeep(extSecretControl)
        Assert.Equal(
            DiagnosticFinality.Final,
            extSecretKeep.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0472").Finality
        )

        const literalPiControl = `package P

import System.Math

func Main() {
    let f = func () {
        let s string = PI
    }
/*CUT*/
    let PI = ""
}
`
        let literalPiKeep = BindKeep(literalPiControl)
        Assert.Equal(
            DiagnosticFinality.Final,
            literalPiKeep.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Finality
        )

        // 9. Block-tail expression in a sibling lambda propagates through overloaded calls in KeepDeclarations.
        const blockTailSource = `package P

import System

class Closed {
    shared {
        func Apply(a Func[int32], b Func[int32, int32]) {
        }

        func Apply(a Func[string], b Func[string, string]) {
        }
    }
}

func G(o object) int32 {
    return 0
}

func Main() {
    let outer = func () {
        Closed.Apply(() -> {
            G(1)
        }, (x) -> {
            return "s"
        })
    }
/*CUT*/
    let G = func (i int32) string {
        return ""
    }
}
`
        AssertWitness(blockTailSource.Replace("/*CUT*/", string.Empty), "GS0155")
        AssertFutureDependent(BindKeep(blockTailSource), "GS0155", "later-overload")

        // 10. Non-identity conversion call `int32(v)` inside a function body can be shadowed by a later
        // top-level global in Nothing mode (while `cast[int32](v)` stays Final).
        const convShadowPrefix = `package P

func Main(v float64) {
    let s string = int32(v)
`
        const convShadowWitness = `}

let int32 = func (x float64) string {
    return ""
}
`
        let convShadowResult = BindNothing(convShadowPrefix, []string{"}\n", convShadowWitness})
        AssertWitness(convShadowPrefix + convShadowWitness, "GS0155")
        AssertFutureDependent(convShadowResult, "GS0155", "later-overload")

        const castControlPrefix = `package P

func Main(v float64) {
    let s string = cast[int32](v)
    let done = 0
`
        let castControlResult = BindNothing(castControlPrefix, []string{"}\n"})
        Assert.Equal(
            DiagnosticFinality.Final,
            castControlResult.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Finality
        )

        // 11. Parameter read inside a lambda whose body also has an unrelated provisional call stays Final.
        const lambdaParamControl = `package P

class Closed {
    func Run(f (int32) -> void) {
    }
}

func G(o object) int32 {
    return 0
}

func Main() {
    Closed().Run((x) -> {
        let a = G(1)
        let bad string = x
    })
/*CUT*/
    let G = func (i int32) string {
        return ""
    }
}
`
        let lambdaParamKeep = BindKeep(lambdaParamControl)
        Assert.Equal(
            DiagnosticFinality.Final,
            lambdaParamKeep.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Finality
        )

        // 12. Expression-bodied sibling lambda reading a provisional variable inside a fixed-signature call
        // does not leak provisionality to the sibling lambda body.
        const fixedSiblingExprVarControl = `package P

class Closed {
    func RunExpr(f () -> int32, g () -> void) {
    }
}

func G(o object) int32 {
    return 0
}

func Main(c Closed) {
    let outer = func () {
        let v = G(1)
        c.RunExpr(() -> v, () -> {
            let bad int32 = "s"
        })
    }
/*CUT*/
    let G = func (i int32) string {
        return ""
    }
}
`
        let fixedSiblingExprVarKeep = BindKeep(fixedSiblingExprVarControl)
        Assert.Equal(
            DiagnosticFinality.Final,
            fixedSiblingExprVarKeep.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Finality
        )

        // 13. Static single-candidate non-generic fixed call records before argument binding.
        const fixedStaticSiblingControl = `package P

class Closed {
    shared {
        func RunExpr(f () -> int32, g () -> void) {
        }
    }
}

func G(o object) int32 {
    return 0
}

func Main() {
    let outer = func () {
        let v = G(1)
        Closed.RunExpr(() -> v, () -> {
            let bad int32 = "s"
        })
    }
/*CUT*/
    let G = func (i int32) string {
        return ""
    }
}
`
        let fixedStaticSiblingKeep = BindKeep(fixedStaticSiblingControl)
        Assert.Equal(
            DiagnosticFinality.Final,
            fixedStaticSiblingKeep.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Finality
        )

        // 14. Calling a CLR delegate local/parameter (`Func[int32]`) stays Final at a KeepDeclarations
        // top-level cut.
        const delegateLocalControl = `package P

import System

func Use(p Func[int32]) {
    let f Func[int32] = () -> 1
    let s1 string = f()
    let s2 string = p()
}

let before = 0
/*CUT*/
let f = func () string {
    return ""
}
let p = func () string {
    return ""
}
`
        let delegateKeep = BindKeep(delegateLocalControl)
        let delegateMismatches = delegateKeep
            .Diagnostics
            .Where((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155")
            .ToList()
        Assert.Equal(2, delegateMismatches.Count)
        Assert.All(delegateMismatches, (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.Final, d.Finality))

        // 15. Fixed-signature exclusion on an outer `.Run` does not skip lambdas in its receiver's
        // overloaded `Choose` subcall.
        const receiverSubcallSource = `package P

import System

class BoxInt {
    func Run(f (int32) -> void) {
    }
}

class BoxStr {
    func Run(f (string) -> void) {
    }
}

func Choose(f Func[int32]) BoxInt {
    return BoxInt()
}

func Choose(f Func[string]) BoxStr {
    return BoxStr()
}

func Use() {
    Choose(() -> int32(1)).Run((x) -> {
        let s string = x
    })
}

let before = 0
/*CUT*/
let int32 = func (i int32) string {
    return ""
}
`
        AssertWitness(receiverSubcallSource.Replace("/*CUT*/", string.Empty), "GS0155")
        AssertFutureDependent(BindKeep(receiverSubcallSource), "GS0155", "later-overload")

        // 16. Overloaded call skips `skipSubtree` when checking the diagnostic's own lambda, so an earlier
        // `return G(1)` in the same lambda does not make an unrelated literal mismatch FutureDependent.
        const overloadedOwnLambdaControl = `package P

class Overloaded {
    func Run(a int32, f () -> int32) {
    }

    func Run(a string, f () -> string) {
    }
}

func G(o object) int32 {
    return 0
}

func Main() {
    Overloaded().Run(1, () -> {
        if false {
            return G(1)
        }
        let bad int32 = "s"
        return 0
    })
/*CUT*/
    let G = func (i int32) string {
        return ""
    }
}
`
        let overloadedOwnKeep = BindKeep(overloadedOwnLambdaControl)
        Assert.Equal(
            DiagnosticFinality.Final,
            overloadedOwnKeep.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0155").Finality
        )
    }

    @Fact
    func AwaitOfAValueThatIsNotATask_IsFinal() {
        const prefix = `package P

partial class Box {
}

async func Main() {
    let b = Box()
    await b
    let done = 0
`
        // G# awaits only a task: a later GetAwaiter does not make a type awaitable.
        let result = BindNothing(
            prefix,
            []string{
                "}\n",
                "}\n\npartial class Box {\n    func GetAwaiter() System.Runtime.CompilerServices.TaskAwaiter {\n        return System.Threading.Tasks.Task.CompletedTask.GetAwaiter()\n    }\n}\n"
            }
        )
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(result.Diagnostics).Finality)
    }

    shared {
        // Binds [`prefix`](paramref) as text that ends at the cut, with nothing after it, and checks that
        // each final diagnostic stays reported in every completion.
        private func BindNothing(prefix string, completions[]string) PrefixBindResult {
            let tree = SyntaxTree.Parse(SourceText.From(prefix, "prefix.gs"))
            let result = Compilation(tree).BindPrefix(
                tree,
                prefix.Length,
                PrefixBindOptions(PrefixRemainder.Nothing, includeScope: false)
            )
            Assert.NotEmpty(result.Diagnostics)
            Assert.NotEmpty(completions)
            for completion in completions {
                let complete = HashSet[string](Diagnose(prefix + completion).Select((d Diagnostic) -> Key(d)))
                for d in result.Diagnostics {
                    if d.Finality == DiagnosticFinality.Final {
                        Assert.True(
                            complete.Contains(Key(d.Diagnostic)),
                            "final ${d} is not in completion:\n${completion}"
                        )
                    }
                }
            }
            return result
        }

        private func BindKeep(source string) PrefixBindResult {
            let cut = source.IndexOf("/*CUT*/", StringComparison.Ordinal)
            Assert.True(cut >= 0)
            let tree = SyntaxTree.Parse(SourceText.From(source.Replace("/*CUT*/", string.Empty), "prefix.gs"))
            return Compilation(tree).BindPrefix(
                tree,
                cut,
                PrefixBindOptions(PrefixRemainder.KeepDeclarations, includeScope: false)
            )
        }

        // The witness completion compiles without the given IDs, so later text removes them.
        private func AssertWitness(complete string, ids ...string) {
            let reported = Diagnose(complete).Select((d Diagnostic) -> d.Id).ToList()
            for id in ids {
                Assert.DoesNotContain(id, reported)
            }
        }

        private func AssertFutureDependent(result PrefixBindResult, id string, reason string) {
            let matching = result.Diagnostics.Where((d ClassifiedDiagnostic) -> d.Diagnostic.Id == id).ToList()
            Assert.NotEmpty(matching)
            for d in matching {
                Assert.Equal(DiagnosticFinality.FutureDependent, d.Finality)
                Assert.Equal(reason, d.Reason)
            }
        }

        private func Diagnose(text string) ImmutableArray[Diagnostic] -> Compilation(
            SyntaxTree.Parse(SourceText.From(text, "prefix.gs"))
        ).GetDiagnostics()

        private func Key(d Diagnostic) string -> "${d.Id}@${d.Location.Span.Start}:${d.Location.Span.Length}"
    }
}
