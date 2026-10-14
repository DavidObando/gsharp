// <copyright file="Issue950ProtectedModifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #950 — the `protected` access modifier. A `protected` member
/// is accessible within its declaring type and within types that derive from it
/// (their own bodies), and is inaccessible from unrelated external code. It is
/// only allowed on members of an inheritable `open class`; structs,
/// non-open/sealed classes, and top-level declarations reject it (GS0380).
/// External access reports GS0379.
open class Issue950ProtectedModifierTests {
    @Fact
    func ProtectedKeyword_LexesAsModifier() {
        Assert.Equal(SyntaxKind.ProtectedKeyword, SyntaxFacts.GetKeywordKind("protected"))
        Assert.Equal("protected", SyntaxFacts.GetText(SyntaxKind.ProtectedKeyword))
    }

    @Fact
    func ProtectedField_ParsesWithoutDiagnostics_OnOpenClass() {
        let source = `
open class Base {
    protected var secret int32
}
0
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func DerivedClass_AccessesInheritedProtectedMember_NoDiagnostics() {
        let source = `
open class Base {
    protected var secret int32
    protected func Reveal() int32 {
        return secret
    }
}

class Derived : Base {
    func Show() int32 {
        secret = 7
        return secret + Reveal()
    }
}

var d = Derived{}
d.Show()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(14, result.Value)
    }

    @Fact
    func ExternalCode_ReadsProtectedField_ReportsGS0379() {
        let source = `
open class Base {
    protected var secret int32
}

var b = Base{}
b.secret
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
    }

    @Fact
    func ExternalCode_CallsProtectedMethod_ReportsGS0379() {
        let source = `
open class Base {
    protected func Reveal() int32 {
        return 1
    }
}

var b = Base{}
b.Reveal()
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
    }

    @Fact
    func ProtectedMember_OnNonOpenClass_ReportsGS0380() {
        let source = `
class Sealed {
    protected var secret int32
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0380")
    }

    @Fact
    func ProtectedMember_OnStruct_ReportsGS0380() {
        let source = `
struct Val {
    protected var x int32
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0380")
    }

    /// Issue #4674: a `protected override` takes its accessibility from the
    /// base member, so a non-`open` class may declare one.
    @Fact
    func ProtectedOverride_OnNonOpenClass_NoPlacementDiagnostic() {
        let source = `
open class Base {
    protected open func Reveal() int32 {
        return 1
    }
    protected open prop Size int32 { get { return 1 } }
    protected open event Changed func()
}
class Sealed : Base {
    protected override func Reveal() int32 {
        return 2
    }
    protected override prop Size int32 { get { return 2 } }
    protected override event Changed func()
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0380")
    }

    /// Issue #4674: the exemption does not extend to a NEW protected member of a
    /// non-`open` class, even one that also declares an override.
    @Fact
    func NewProtectedMethod_OnNonOpenClassWithOverride_ReportsGS0380() {
        let source = `
open class Base {
    protected open func Reveal() int32 {
        return 1
    }
}
class Sealed : Base {
    protected override func Reveal() int32 {
        return 2
    }
    protected func Other() int32 {
        return 3
    }
}
0
`
        let result = Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0380")
        Assert.Equal(11, diagnostic.Location.StartLine + 1)
    }

    @Fact
    func ProtectedMethod_OnOpenClass_NoPlacementDiagnostic() {
        let source = `
open class Base {
    protected func Reveal() int32 {
        return 1
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0380")
    }

    @Fact
    func ProtectedTopLevelClass_ReportsGS0380() {
        let source = `
protected class Foo {
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0380")
    }

    @Fact
    func UnrelatedClass_CallsProtectedMember_ReportsGS0379() {
        // A sibling type that does NOT derive from Base may not reach a
        // protected member, even though both are user types in the same file.
        let source = `
open class Base {
    protected func Reveal() int32 {
        return 1
    }
}

class Other {
    func Probe(b Base) int32 {
        return b.Reveal()
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
