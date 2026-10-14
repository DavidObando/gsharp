// <copyright file="Adr0185TupleDestructuringParameterBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// ADR-0185 — binder-level tests for tuple-destructuring arrow-lambda
/// parameters: each destructured name binds as an ordinary local of its
/// declared element type, in the lambda's own scope (not visible outside
/// it), the arity-<2 diagnostic fires (G# has no 1-tuples), and the
/// ported issue #2810 explicit-parameter/target-slot compatibility check
/// applies to the destructured shape too.
class Adr0185TupleDestructuringParameterBinderTests {
    @Fact
    func EachDestructuredElement_BindsAsItsDeclaredType() {
        // `x` bound as `string` — string + string concatenation compiles.
        let diagnostics = Bind(`func Test() string {
    let f = ((x string, y int32)) -> x + "!"
    return f(("hi", 1))
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func EachDestructuredElement_BindsAsItsDeclaredType_TypeMismatchReported() {
        // `x` bound as `string`, not `int32` — using it where an int32 is
        // required is a genuine type error, proving the element's REAL
        // declared type (not the whole tuple's) is what got bound.
        let diagnostics = Bind(`func Test() int32 {
    let f = ((x string, y int32)) -> x + 1
    return f(("hi", 1))
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func DestructuredElements_NotVisibleOutsideTheLambda() {
        let diagnostics = Bind(`func Test() int32 {
    let f = ((x int32, y int32)) -> x + y
    return x
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func DestructuredElements_EachInOwnRightScope_SameNameAcrossSiblingLambdasOk() {
        // Two separate destructured lambdas may each use the same element
        // names without colliding — each declares into its own lambda scope.
        let diagnostics = Bind(`func Test() int32 {
    let f = ((x int32, y int32)) -> x + y
    let g = ((x int32, y int32)) -> x - y
    return f((3, 4)) + g((3, 4))
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SingleElementPattern_ReportsAtLeastTwoElementsDiagnostic() {
        // G# has no 1-tuples (ADR-0185 open question 2's judgment call,
        // mirroring the tuple TYPE grammar's existing `(T)` grouping
        // precedent) — this is a BIND-time rejection; the pattern itself
        // parses cleanly.
        let diagnostics = Bind(`func Test() int32 {
    let f = ((x int32)) -> x
    return f((1))
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0592")
    }

    @Fact
    func SingleElementPattern_StillDeclaresElementAsErrorTyped_NoCascadingUndefinedDiagnostic() {
        // Even though the pattern is rejected, `x` is still declared
        // (error-typed) so the body doesn't ALSO report "x doesn't exist" on
        // top of the arity diagnostic.
        let diagnostics = Bind(`func Test() int32 {
    let f = ((x int32)) -> x
    return 0
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func DiscardElement_NotReferenceableInBody() {
        let diagnostics = Bind(`func Test() int32 {
    let f = ((x int32, _ int32)) -> x + _
    return f((1, 2))
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func OrdinarySingleTupleTypedParameter_BindsAsOneParameter_RegressionUnaffected() {
        let diagnostics = Bind(`func Test() int32 {
    let f = (pair (int32, int32)) -> pair.Item1 + pair.Item2
    return f((1, 2))
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ExplicitDestructuredParameterType_IncompatibleWithTargetSlot_IsRejected() {
        // Issue #2810 ported to the destructured shape: an explicit
        // destructured parameter type is a contract the target delegate's
        // slot type must convert implicitly TO — mirrors
        // Issue2810ExplicitLambdaParameterConversionTests's ordinary-
        // parameter case.
        let diagnostics = Bind(`import System.Collections.Generic
import System.Linq

func Test(pairs List[(string, int32)]) {
    pairs.Where(((x int32, y int32)) -> x == y)
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func AnnotationOnDestructuredParameter_IsValidatedNotSilentlyDropped() {
        // Review finding: the destructured-parameter branch used to build
        // the tuple ParameterSymbol and `continue` without ever calling
        // AttachParameterAttributes — silently dropping any `@Attr` written
        // before the pattern, and skipping whatever attribute-target
        // validation that call performs. `@Obsolete`'s own [AttributeUsage]
        // excludes Parameter (mirrors the ordinary-parameter regression test
        // AttributeBinderTests.Obsolete_On_Parameter_Reports_GS0209): if
        // validation now genuinely runs for a destructured parameter too,
        // the same GS0209 must fire here.
        let diagnostics = Bind(`import System

func Test() int32 {
    let f = (@Obsolete("dead") (x int32, y int32)) -> x + y
    return f((1, 2))
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0209")
    }

    @Fact
    func AnnotationOnDestructuredParameter_ValidTarget_AttachesWithNoDiagnostic() {
        // The positive counterpart: a user-declared attribute whose
        // [AttributeUsage] DOES permit Parameter attaches cleanly (no
        // GS0209, no diagnostics at all) to a destructured parameter,
        // exactly as it would to an ordinary one — destructuring the
        // parameter's SHAPE doesn't change what attribute targets are legal
        // on it. Given an explicit argument list of its own (`@Marker(1)`,
        // mirroring `@Obsolete("dead")` above): a ZERO-argument annotation
        // immediately followed by `(` is a separate, pre-existing parser
        // ambiguity (ParseAnnotation always greedily consumes a following
        // `(` as ITS OWN argument list — unrelated to destructuring, and out
        // of scope here) that would misparse `@Marker (x int32, y int32)` as
        // `Marker`'s own (invalid) argument list instead of an annotation
        // followed by a destructuring pattern.
        let diagnostics = Bind(`import System

@Attribute
@AttributeUsage(AttributeTargets.Parameter)
class MarkerAttribute(id int32) {
}

func Test() int32 {
    let f = (@Marker(1) (x int32, y int32)) -> x + y
    return f((1, 2))
}`)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            using let references = ReferenceResolver.WithReferences(
                Directory.EnumerateFiles(
                    RuntimeEnvironment.GetRuntimeDirectory(),
                    "*.dll",
                    SearchOption.TopDirectoryOnly
                )
            )
            let compilation = Compilation(references, SyntaxTree.Parse(SourceText.From(source)))
            return compilation
                .SyntaxTrees
                .SelectMany(
                func (tree SyntaxTree) IEnumerable[Diagnostic] {
                    return tree.Diagnostics
                }
            )
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToImmutableArray()
        }
    }
}
