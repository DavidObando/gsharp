// <copyright file="Issue2210ImportedBaseUnqualifiedCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2210: an unqualified (implicit-`this`) call to a method
/// inherited from an IMPORTED (metadata) base class must resolve, mirroring
/// the existing behavior for a method inherited from a G#-defined base class.
/// Two historic defects are covered here:
/// - The implicit-`this` call path (and the qualified `this.Method(...)` path it shares logic with)
/// only consulted the enclosing type's OWN `ImportedBaseType`, rather than walking the transitive
/// G#-defined base-class chain (issue #1582's `GetInheritedClrBaseType`), so a metadata base reached
/// through one or more intermediate G# classes was invisible.
/// - Only `public` inherited CLR instance methods were considered (`protected` / `protected internal`
/// members — like CommunityToolkit.Mvvm's `ObservableObject.OnPropertyChanged` — were never surfaced,
/// unlike inherited protected fields, which issue #1582 already covered).
/// Note: the issue's literal repro used `System.Text.StringBuilder`, but
/// that type is `sealed` on the current target framework (so it cannot
/// legally be a G# base class at all); `System.Exception` is used here
/// instead as a representative non-sealed BCL base, matching the convention
/// already used by (cref:Issue1582MetadataBaseInheritedMemberTests).
open class Issue2210ImportedBaseUnqualifiedCallTests {
    @Fact
    func PublicMethod_InheritedFromImportedBase_UnqualifiedCall_Binds() {
        // System.Exception.GetBaseException() is public; MyE inherits it
        // directly from the imported base.
        const source = `package T
import System
class MyE : Exception { func Add() { GetBaseException() } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ProtectedMethod_InheritedFromImportedBase_UnqualifiedCall_Binds() {
        // System.ComponentModel.Component declares protected `Dispose(bool)`.
        const source = `package T
import System.ComponentModel
class MyComp : Component { func Cleanup() { Dispose(false) } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func PublicMethod_InheritedFromImportedBase_TwoLevelsUp_UnqualifiedCall_Binds() {
        // MyE directly extends Exception (imported). MyGrandE is a G# class
        // extending MyE; GetBaseException is inherited transitively through a
        // mixed G#/imported chain.
        const source = `package T
import System
open class MyE : Exception { }
class MyGrandE : MyE { func Add() { GetBaseException() } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ProtectedMethod_InheritedFromImportedBase_TwoLevelsUp_UnqualifiedCall_Binds() {
        // Same as above but for a PROTECTED member, proving both defects
        // (chain-walk depth + protected accessibility) compose correctly.
        const source = `package T
import System.ComponentModel
open class MyComp : Component { }
class MyGrandComp : MyComp { func Cleanup() { Dispose(false) } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func OwnMethod_ShadowsImportedBaseMethod_ResolvesToOwnMethod() {
        // Own-class method named the same as an imported-base member must
        // still win (no ambiguity/regression from walking the imported base).
        // Both overloads share the same signature/return type, so this must
        // inspect the BOUND call's resolved symbol — asserting only
        // Assert.Empty(diagnostics) would pass even if the inherited (wrong)
        // method won.
        const source = `package T
import System
class MyE : Exception {
    func GetBaseException() Exception { return this }
    func Add() { GetBaseException() }
}`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let call BoundExpression? = FindInstanceCall(compilation, "GetBaseException")
        Assert.IsType[BoundUserInstanceCallExpression](call)
    }

    @Fact
    func ProtectedMethod_InheritedFromImportedBase_QualifiedCallFromUnrelatedClass_ReportsGS0379() {
        // Issue #2218 rubber-duck review: `TryBindInheritedClrInstanceCall`
        // unions in `protected`/`protected internal` inherited CLR methods so
        // implicit-`this`/`this.` calls resolve (issue #2210), but this
        // helper is also reached from the general qualified-accessor path,
        // which handles ANY `receiver.Method(...)` call. Without an
        // accessibility gate, `Dispose(bool)` (protected on
        // System.ComponentModel.Component) became callable through an
        // arbitrary receiver from completely unrelated code — an
        // accessibility leak. This must report the same GS0379 diagnostic G#
        // already uses for a protected member accessed from outside its
        // declaring/derived type.
        const source = `package T
import System.ComponentModel
class MyComp : Component { }
class Other { func F(c MyComp) { c.Dispose(false) } }`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0379")
    }

    @Fact
    func ProtectedMethod_InheritedFromImportedBase_ExplicitThisQualifiedCall_Binds() {
        // The explicit `this.Method(...)` form (not just the implicit-`this`
        // form already covered above) must keep resolving to the protected
        // inherited member from WITHIN the derived class — no false-positive
        // GS0379 from the accessibility-leak fix.
        const source = `package T
import System.ComponentModel
class MyComp : Component { func Cleanup() { this.Dispose(false) } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GenuinelyAbsentMethod_ThroughImportedBase_ReportsGS0130() {
        const source = `package T
import System
class MyE : Exception { func Add() { NoSuchMethod() } }`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0130")
    }

    private class InstanceCallCollector : BoundTreeWalker {
        private let methodName string

        init(methodName string) {
            Collected = List[BoundExpression]()
            this.methodName = methodName
        }

        prop Collected List[BoundExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            switch node {
                case userCall is BoundUserInstanceCallExpression when userCall.Method.Name == methodName {
                    Collected.Add(userCall)
                }
                case importedCall is BoundImportedInstanceCallExpression when importedCall.Method.Name == methodName {
                    Collected.Add(importedCall)
                }
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree)
        }

        private func FindInstanceCall(compilation Compilation, methodName string) BoundExpression? {
            let collector = InstanceCallCollector(methodName)
            for body in compilation.BoundProgram.Functions.Values {
                collector.Visit(body)
            }
            return collector.Collected.FirstOrDefault()
        }

        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let compilation = Compile(source)
            // BoundProgram fully binds function bodies (where member access is
            // resolved), surfacing body-level diagnostics such as GS0130 —
            // GlobalScope.Diagnostics only covers declaration-level binding.
            return compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics).ToList()
        }
    }
}
