// <copyright file="Issue1552NullableArgOverloadTests.cs" company="GSharp">
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

/// Issue #1552. When a nullable REFERENCE argument `S?` is passed to an
/// overload SET, overload resolution must do the null-safe thing rather than
/// report a spurious GS0266 ambiguity (which ignored the `?` wrapper):
/// - If a null-tolerant overload exists (a parameter typed `object`/ `object?` or itself nullable), it
/// is selected — a nullable reference is a valid value there.
/// - If EVERY surviving overload wants a non-nullable, non-`object` reference parameter, the call
/// reports the SAME GS0154 the single-candidate path already emits, prompting the user to write `!!`
/// (or narrow).
/// Crucially this PRESERVES G#'s Kotlin-model null safety: `T? -> T`
/// (reference) is NOT made implicit anywhere. The abandoned PR #1553 silenced
/// GS0154/GS0155 by making that conversion implicit language-wide; this fix does
/// not — the null-safety diagnostic is retained, only re-routed away from the
/// spurious ambiguity. Every user type below uses an `Issue1552`-unique
/// name because the in-process FunctionTypeSymbol cache is not cleared between
/// tests.
open class Issue1552NullableArgOverloadTests {
    @Fact
    func AOverload_NullableImportedType_SelectsObjectOverload_NoDiagnostics() {
        // Repro (a): imported base/derived (object / System.Type). A nullable
        // `Type?` argument must cleanly select F(object) — object is null-
        // tolerant — with NO GS0266 and no error.
        const source = `
package p
import System
func Issue1552AF(caller object) int32 -> 1
func Issue1552AF(caller Type) int32 -> 2
func Issue1552AUseNull(t Type?) int32 -> Issue1552AF(t)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue1552AF")
        Assert.NotNull(selected)
        Assert.Equal(TypeSymbol.Object, selected!!.Parameters[0].Type)
    }

    @Fact
    func AOverload_NonNullableImportedType_StillSelectsDerivedOverload() {
        // Control: a NON-nullable `Type` argument still selects F(Type) — the
        // gate never fires for a non-nullable argument.
        const source = `
package p
import System
func Issue1552NnF(caller object) int32 -> 1
func Issue1552NnF(caller Type) int32 -> 2
func Issue1552NnUse(t Type) int32 -> Issue1552NnF(t)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue1552NnF")
        Assert.NotNull(selected)
        Assert.NotEqual(TypeSymbol.Object, selected!!.Parameters[0].Type)
        Assert.Equal(typeof(Type), selected!!.Parameters[0].Type.ClrType)
    }

    @Fact
    func CUser_NullableUserDerived_ReportsGS0154_NotGS0266() {
        // Repro (c): only non-nullable-reference overloads (no object overload).
        // A nullable `Issue1552CDog?` argument must report GS0154 (the same
        // null-safety diagnostic the single-candidate path emits) — NOT GS0266,
        // NOT a generic no-applicable-overload.
        const source = `
package p
open class Issue1552CAnimal {}
class Issue1552CDog : Issue1552CAnimal {}
func Issue1552CG(a Issue1552CAnimal) int32 -> 1
func Issue1552CG(d Issue1552CDog) int32 -> 2
func Issue1552CUse(d Issue1552CDog?) int32 -> Issue1552CG(d)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        let gs0154 = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0154")
        Assert.Contains("Issue1552CAnimal", gs0154.Message)
        Assert.Contains("Issue1552CDog?", gs0154.Message)
    }

    @Fact
    func CUser_SingleCandidate_AlsoReportsGS0154_Analog() {
        // The single-candidate analog of repro (c) already reports GS0154 today;
        // the overload case above must MATCH it (same diagnostic id).
        const source = `
package p
open class Issue1552SAnimal {}
class Issue1552SDog : Issue1552SAnimal {}
func Issue1552SSink(a Issue1552SAnimal) int32 -> 1
func Issue1552SUse(d Issue1552SDog?) int32 -> Issue1552SSink(d)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func CUser_BangEscape_Compiles_SelectsDerivedOverload() {
        // The `!!` escape hatch narrows `Dog?` to `Dog`, so the gate never fires
        // and the derived overload G(Dog) is selected.
        const source = `
package p
open class Issue1552BAnimal {}
class Issue1552BDog : Issue1552BAnimal {}
func Issue1552BG(a Issue1552BAnimal) int32 -> 1
func Issue1552BG(d Issue1552BDog) int32 -> 2
func Issue1552BUse(d Issue1552BDog?) int32 -> Issue1552BG(d!!)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue1552BG")
        Assert.NotNull(selected)
        Assert.Equal("Issue1552BDog", selected!!.Parameters[0].Type.Name)
    }

    @Fact
    func NonNullableUserArg_StillSelectsDerivedOverload() {
        // Control: a non-nullable `Dog{}` argument still selects G(Dog).
        const source = `
package p
open class Issue1552NAnimal {}
class Issue1552NDog : Issue1552NAnimal {}
func Issue1552NG(a Issue1552NAnimal) int32 -> 1
func Issue1552NG(d Issue1552NDog) int32 -> 2
func Issue1552NUse() int32 -> Issue1552NG(Issue1552NDog{})
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue1552NG")
        Assert.NotNull(selected)
        Assert.Equal("Issue1552NDog", selected!!.Parameters[0].Type.Name)
    }

    @Fact
    func NullableParameterOverload_StillApplies_ForNullableRefArg() {
        // A null-tolerant nullable-parameter overload accepts the nullable-ref
        // argument (S? -> S? / base-S?). No GS0154, no GS0266.
        const source = `
package p
open class Issue1552PAnimal {}
class Issue1552PDog : Issue1552PAnimal {}
func Issue1552PG(a Issue1552PAnimal?) int32 -> 1
func Issue1552PG(s string) int32 -> 2
func Issue1552PUse(d Issue1552PDog?) int32 -> Issue1552PG(d)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue1552PG")
        Assert.NotNull(selected)
        Assert.IsType[NullableTypeSymbol](selected!!.Parameters[0].Type)
    }

    @Fact
    func ValueTypeNullable_Unaffected_ByGate() {
        // The gate must NOT touch value-type nullables. `int32?` still lifts /
        // widens through the normal conversion lattice; here it selects the
        // lifted-widening `int64?` overload with no null-safety GS0154.
        const source = `
package p
func Issue1552VG(a int64?) int32 -> 1
func Issue1552VG(a string) int32 -> 2
func Issue1552VUse(n int32?) int32 -> Issue1552VG(n)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0154")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue1552VG")
        Assert.NotNull(selected)
        Assert.IsType[NullableTypeSymbol](selected!!.Parameters[0].Type)
    }

    @Fact
    func GenuineAmbiguity_StillReportsGS0266() {
        // Two unrelated interfaces both satisfied by the argument genuinely tie.
        // The nullable-reference gate does not fire (both params are null-
        // tolerant only via nullable form? no — they are non-nullable
        // interfaces, but the argument is non-nullable `Both`), so this remains
        // a real ambiguity => GS0266.
        const source = `
package p
interface Issue1552IA {}
interface Issue1552IB {}
class Issue1552Both : Issue1552IA, Issue1552IB {}
func Issue1552AmbTake(x Issue1552IA) int32 -> 1
func Issue1552AmbTake(x Issue1552IB) int32 -> 2
func Issue1552AmbUse(b Issue1552Both) int32 -> Issue1552AmbTake(b)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
    }

    @Fact
    func DeeperChain_GrandbaseBaseDerived_NullableDerived_ReportsGS0154() {
        // Generality: any base/derived depth. A `Derived?` argument against
        // overloads on Grandbase and Base (no object overload) reports GS0154.
        const source = `
package p
open class Issue1552DGrand {}
open class Issue1552DBase : Issue1552DGrand {}
class Issue1552DDerived : Issue1552DBase {}
func Issue1552DG(a Issue1552DGrand) int32 -> 1
func Issue1552DG(b Issue1552DBase) int32 -> 2
func Issue1552DUse(d Issue1552DDerived?) int32 -> Issue1552DG(d)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        let gs0154 = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0154")
        Assert.Contains("Issue1552DDerived?", gs0154.Message)
    }

    @Fact
    func DeeperChain_NullableDerived_ToObject_SelectsObject() {
        // Generality: with a null-tolerant object overload present, a deep-chain
        // nullable IMPORTED argument (ArgumentException : ... : Exception)
        // selects object cleanly (imported reference types have a live ClrType,
        // so S? -> object is a genuine implicit box/upcast). The non-object
        // Exception overload is dropped by the null-safety gate.
        const source = `
package p
import System
func Issue1552OG(a object) int32 -> 1
func Issue1552OG(b Exception) int32 -> 2
func Issue1552OUse(d ArgumentException?) int32 -> Issue1552OG(d)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue1552OG")
        Assert.NotNull(selected)
        Assert.Equal(TypeSymbol.Object, selected!!.Parameters[0].Type)
    }

    private class CallCollector : BoundTreeWalker {
        private let callName string

        init(callName string) {
            Collected = List[FunctionSymbol]()
            this.callName = callName
        }

        prop Collected List[FunctionSymbol] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            switch node {
                case call is BoundCallExpression when call.Function.Name == callName {
                    Collected.Add(call.Function)
                }
                case instanceCall is BoundUserInstanceCallExpression when instanceCall.Method.Name == callName {
                    Collected.Add(instanceCall.Method)
                }
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }

        private func FindCall(compilation Compilation, callName string) FunctionSymbol? {
            let collector = Issue1552NullableArgOverloadTests.CallCollector(callName)
            for body in compilation.BoundProgram.Functions.Values {
                collector.Visit(body)
            }
            return collector.Collected.FirstOrDefault()
        }
    }
}
