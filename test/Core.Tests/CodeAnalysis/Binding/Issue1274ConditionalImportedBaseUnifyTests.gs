// <copyright file="Issue1274ConditionalImportedBaseUnifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1274: a conditional / if-expression whose two arms are an
/// imported/BCL base class and a user-defined subclass of it (or two user
/// subclasses of the same imported base) must unify to the imported base via
/// best-common-type — matching the user-defined-base behavior. The bug was that
/// the best-common-type ancestor enumeration (and the conversion classifier)
/// only walked a user type's user-defined base chain (`BaseClass`) and did
/// not recognise the imported base recorded in
/// (cref:GSharp.Core.CodeAnalysis.Symbols.StructSymbol.ImportedBaseType).
/// The user-defined-base controls must keep working (no regression).
open class Issue1274ConditionalImportedBaseUnifyTests {
    @Fact
    func ImportedBase_TrueArm_UserSubclass_FalseArm_Unifies_NoDiagnostics() {
        let diagnostics = Bind(ImportedHierarchy + `
func F(b bool, e Exception) Exception {
    return if b { e } else { MyEx() }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ImportedBase_UserSubclass_TrueArm_ImportedBase_FalseArm_Unifies_NoDiagnostics() {
        let diagnostics = Bind(ImportedHierarchy + `
func F(b bool, e Exception) Exception {
    return if b { MyEx() } else { e }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func TwoUserSubclasses_OfSameImportedBase_UnifyToImportedBase_NoDiagnostics() {
        let diagnostics = Bind(ImportedHierarchy + `
func F(b bool, x MyExA, y MyExB) Exception {
    return if b { x } else { y }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func MultiLevelUserSubclass_VsImportedBase_UnifyToImportedBase_NoDiagnostics() {
        let diagnostics = Bind(ImportedHierarchy + `
func F(b bool, e Exception, d MyExDeep) Exception {
    return if b { e } else { d }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func MultiLevelUserSubclasses_OnlySharedAncestorIsImportedBase_NoDiagnostics() {
        let diagnostics = Bind(ImportedHierarchy + `
func F(b bool, d MyExDeep, y MyExB) Exception {
    return if b { d } else { y }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Ternary_ImportedBase_VsUserSubclass_Unifies_NoDiagnostics() {
        let diagnostics = Bind(ImportedHierarchy + `
func F(b bool, e Exception) Exception {
    return b ? e : MyEx()
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Control_UserBase_VsUserSubclass_StillUnifies_NoDiagnostics() {
        let diagnostics = Bind(UserHierarchy + `
func F(b bool, a Animal, d Dog) Animal {
    return if b { a } else { d }
}
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Control_SiblingUserSubclasses_StillUnify_NoDiagnostics() {
        let diagnostics = Bind(UserHierarchy + `
func F(b bool, c Cat, d Dog) Animal {
    return if b { c } else { d }
}
`)
        Assert.Empty(diagnostics)
    }

    shared {
        private const ImportedHierarchy string = `
import System
open class MyEx : Exception { }
open class MyExA : Exception { }
open class MyExB : Exception { }
open class MyExDeep : MyExA { }
`

        private const UserHierarchy string = `
open class Animal { }
class Dog : Animal { }
class Cat : Animal { }
`

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
