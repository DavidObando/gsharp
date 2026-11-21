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
