// <copyright file="Issue2146ReferenceBetternessTests.cs" company="GSharp">
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
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2146: overload resolution's "better function member" pass now applies
/// the C# §7.5.3.4 "better conversion target" rule for REFERENCE types, not just
/// numeric ones. When an argument's static type is a proper subtype of BOTH
/// candidate parameter types (so both argument→parameter conversions are
/// non-identity implicit reference conversions), the more-derived parameter type
/// wins instead of the call being reported ambiguous (GS0266). Genuinely
/// unrelated reference targets still tie and report GS0266.
open class Issue2146ReferenceBetternessTests {
    @Fact
    func ObjectVsUserBaseClass_DerivedArgument_PrefersBaseClassOverload() {
        // U(object) vs U(Animal) called with a Dog argument: Dog->object and
        // Dog->Animal are both non-identity implicit reference conversions, so
        // they tie on conversion kind. Animal is the better conversion target
        // (Animal->object is implicit, object->Animal is not), so U(Animal) must
        // win. Before the fix this reported a spurious GS0266.
        const source = `
package p
open class Issue2146Animal {}
class Issue2146Dog : Issue2146Animal {}
func Issue2146U(x object) int32 -> 1
func Issue2146U(x Issue2146Animal) int32 -> 2
func Issue2146Use(d Issue2146Dog) int32 -> Issue2146U(d)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue2146U")
        Assert.NotNull(selected)
        Assert.Equal("Issue2146Animal", selected!!.Parameters[0].Type.Name)
    }

    @Fact
    func IdentityArgument_StillWinsOverObject() {
        // Control (already-working case): U(object) vs U(Animal) called with an
        // Animal argument. Animal->Animal is IDENTITY, which beats the
        // Animal->object reference conversion, so U(Animal) resolves without any
        // reference tie-break needing to run.
        const source = `
package p
open class Issue2146AnimalId {}
func Issue2146UId(x object) int32 -> 1
func Issue2146UId(x Issue2146AnimalId) int32 -> 2
func Issue2146UseId(a Issue2146AnimalId) int32 -> Issue2146UId(a)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue2146UId")
        Assert.NotNull(selected)
        Assert.Equal("Issue2146AnimalId", selected!!.Parameters[0].Type.Name)
    }

    @Fact
    func ThreeLevelHierarchy_PrefersMostDerivedApplicableTarget() {
        // U(object) vs U(Animal) with a Dog argument where Dog : Animal : object.
        // The more-derived applicable target (Animal) must win over object.
        const source = `
package p
open class Issue2146Base {}
open class Issue2146Mid : Issue2146Base {}
class Issue2146Leaf : Issue2146Mid {}
func Issue2146H(x Issue2146Base) int32 -> 1
func Issue2146H(x Issue2146Mid) int32 -> 2
func Issue2146HUse(leaf Issue2146Leaf) int32 -> Issue2146H(leaf)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue2146H")
        Assert.NotNull(selected)
        Assert.Equal("Issue2146Mid", selected!!.Parameters[0].Type.Name)
    }

    @Fact
    func ObjectVsImportedNullableType_TypeofArgument_PrefersTypeOverload() {
        // The real-world Oahu case: Log(object) vs Log(Type?) with a typeof(...)
        // argument. Type->object and Type->Type? are both non-identity implicit
        // reference/nullable conversions; Type? is the better (more-derived)
        // target, so Log(Type?) must win instead of GS0266.
        const source = `
package p
import System
class Issue2146LogC {}
func Issue2146L(caller object) int32 -> 1
func Issue2146L(caller Type?) int32 -> 2
func Issue2146LUse() int32 -> Issue2146L(typeof(Issue2146LogC))
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue2146L")
        Assert.NotNull(selected)
        Assert.NotEqual("object", selected!!.Parameters[0].Type.Name)
    }

    @Fact
    func UnrelatedReferenceTargets_StillReportsAmbiguity() {
        // Guard against over-fixing: two UNRELATED interface parameter types,
        // both satisfied by the argument, with neither convertible to the other.
        // This is a genuine ambiguity and must still report GS0266.
        const source = `
package p
interface Issue2146IA {}
interface Issue2146IB {}
class Issue2146Both : Issue2146IA, Issue2146IB {}
func Issue2146A(x Issue2146IA) int32 -> 1
func Issue2146A(x Issue2146IB) int32 -> 2
func Issue2146AUse(b Issue2146Both) int32 -> Issue2146A(b)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
    }

    @Fact
    func ObjectVsInterface_ImplementingArgument_PrefersInterfaceOverload() {
        // U(object) vs U(IShape) with an argument that implements IShape. Both
        // conversions are non-identity implicit reference conversions; IShape is
        // the more-derived (more specific) target versus object, so U(IShape)
        // must win rather than tie at GS0266.
        const source = `
package p
interface Issue2146IShape {}
class Issue2146Square : Issue2146IShape {}
func Issue2146S(x object) int32 -> 1
func Issue2146S(x Issue2146IShape) int32 -> 2
func Issue2146SUse(sq Issue2146Square) int32 -> Issue2146S(sq)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0266")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let selected FunctionSymbol? = FindCall(compilation, "Issue2146S")
        Assert.NotNull(selected)
        Assert.Equal("Issue2146IShape", selected!!.Parameters[0].Type.Name)
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
            let collector = Issue2146ReferenceBetternessTests.CallCollector(callName)
            for body in compilation.BoundProgram.Functions.Values {
                collector.Visit(body)
            }
            return collector.Collected.FirstOrDefault()
        }
    }
}
