// <copyright file="Issue2256QualifiedConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Linq
import Xunit

/// Issue #2256: cs2gs fully-qualifies type references, so a generic-math
/// constraint `where TCallback : INewSplitCallback<TCallback>` is
/// emitted as the G# constraint `[TCallback Oahu.Decrypt.INewSplitCallback[TCallback]]`.
/// Three gsc bugs combined to block this: (1) the parser rejected a dotted
/// type-parameter constraint (GS0005), (2) a reference-set qualified generic
/// type name failed to resolve (GS0113), and (3) a same-compilation
/// package-qualified source type failed to resolve (GS0113 / GS0157). These
/// tests pin the fixes.
open class Issue2256QualifiedConstraintTests {
    @Fact
    func DottedConstraint_Parses_WithoutDiagnostics() {
        const source = `package P
import System
func Max[T System.IComparable[T]](a T, b T) T {
    if a.CompareTo(b) > 0 { return a }
    return b
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp TypeParameterSyntax? = FindFirstTypeParameter(tree)
        Assert.Equal("T", tp!!.Identifier.Text)
        Assert.NotNull(tp!!.ConstraintType)
        Assert.Equal("System", tp!!.Constraint!!.Text)
        Assert.Equal("System.IComparable", tp!!.ConstraintType!!.DottedName)
    }

    @Fact
    func SamePackage_QualifiedGenericSourceType_AsAnnotation_Binds() {
        const source = `package A.B
import System

interface IFoo[T] {
    func Baz(x T) T;
}

func UseGen(f A.B.IFoo[int32]) int32 -> f.Baz(3)`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func SamePackage_QualifiedNonGenericSourceType_Binds() {
        const source = `package A.B
import System

interface IPlain {
    func Bar(x int32) int32;
}

func UsePlain(f A.B.IPlain) int32 -> f.Bar(3)`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func SelfReferentialQualifiedCrtpConstraint_InPackage_Binds() {
        const source = `package Oahu.Decrypt
import System

interface INewSplitCallback[TCallback] {
    func OnSplit(x TCallback) TCallback;
}

func Register[TCallback Oahu.Decrypt.INewSplitCallback[TCallback]](c TCallback, v TCallback) TCallback -> c.OnSplit(v)`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedSourceType_ConstructorCall_InExpression_Binds() {
        // cs2gs fully-qualifies constructor calls; the package prefix on a
        // same-compilation source type is redundant and must be peeled.
        const source = `package Oahu.Decrypt
import System

class Mp4Operation[T] {
    func Hello() int32 -> 42
}

func Make() Oahu.Decrypt.Mp4Operation[int32] -> Oahu.Decrypt.Mp4Operation[int32]()`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedSourceType_StaticCallOnGenericType_InExpression_Binds() {
        // `Ns.Type[Args].StaticMethod(...)`: the generic type receiver parses as
        // an index expression, and the package prefix is redundant on a source
        // type. Fix 4b peels the prefix and binds the static call by simple name.
        const source = `package Oahu.Decrypt
import System

class Mp4Operation[T] {
    shared {
        func FromCompleted(x int32, y T?) Oahu.Decrypt.Mp4Operation[T] -> Oahu.Decrypt.Mp4Operation[T]()
    }
    func Hello() int32 -> 42
}

func Make() Oahu.Decrypt.Mp4Operation[int32] -> Oahu.Decrypt.Mp4Operation[int32].FromCompleted(3, nil)`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedSourceType_StaticFieldWrite_OnGenericType_Binds() {
        // Assignment LHS (write path): `Ns.Type[T].field = value`. The qualified
        // generic type receiver must be recognized as a static-type receiver
        // after peeling the redundant package prefix.
        const source = `package Oahu.Aux.Diagnostics
import System

class TreeDecomposition[T] {
    shared {
        private var default_ Oahu.Aux.Diagnostics.TreeDecomposition[T]?
        prop Instance Oahu.Aux.Diagnostics.TreeDecomposition[T] {
            get {
                if Oahu.Aux.Diagnostics.TreeDecomposition[T].default_ == nil {
                    Oahu.Aux.Diagnostics.TreeDecomposition[T].default_ = Oahu.Aux.Diagnostics.TreeDecomposition[T]()
                }
                return Oahu.Aux.Diagnostics.TreeDecomposition[T].default_!!
            }
        }
    }
}`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedSourceType_VoidStaticCall_AsExpressionBody_Binds() {
        // A `Ns.Type[T].VoidMethod(...)` call in an expression-bodied void member:
        // peeling the prefix must not prematurely reject the void terminal.
        const source = `package P
import System

class TD[T] {
    shared {
        func Write(x int32) -> nil
    }
    func Use() -> P.TD[T].Write(3)
}`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func QualifiedClrType_DeepNamespace_EnumMemberAccess_Binds() {
        const source = `package P

func Flag() GSharp.Core.CodeAnalysis.Syntax.SyntaxKind -> GSharp.Core.CodeAnalysis.Syntax.SyntaxKind.BadToken`
        let compilation = Compile(source)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    shared {
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }

        private func FindFirstTypeParameter(tree SyntaxTree) TypeParameterSyntax? {
            var found TypeParameterSyntax? = nil
            let Walk = func (node SyntaxNode) {
                if found != nil {
                    return
                }
                if node is TypeParameterSyntax tp {
                    found = tp
                    return
                }
                for c in node.GetChildren() {
                    Walk(c)
                }
            }
            Walk(tree.Root)
            return found
        }
    }
}
