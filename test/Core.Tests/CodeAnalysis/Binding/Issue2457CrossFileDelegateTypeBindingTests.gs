// <copyright file="Issue2457CrossFileDelegateTypeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2457: named delegate signatures bind against the complete declaration
/// symbol table rather than the syntax-tree prefix processed so far.
open class Issue2457CrossFileDelegateTypeBindingTests {
    @Theory
    @InlineData(true)
    @InlineData(false)
    func SamePackageTypes_ResolveInDelegateConstraintsParametersAndReturns_RegardlessOfFileOrder(delegateFirst bool) {
        let sources = if delegateFirst {
            []string{Delegates, Types}
        } else {
            []string{Types, Delegates}
        }
        AssertNoErrors(sources)
    }

    @Fact
    func PublicImportedCrossPackageTypes_ResolveInDelegateSignature() {
        const shared = `package Shared

interface IConstraint {}
data class Result(Value string) {}`
        const consumer = `package Consumer
import Shared
import System.Collections.Generic

delegate Convert[T IConstraint](value Result) List[Result];`
        AssertNoErrors([]string{consumer, shared})
    }

    @Fact
    func SamePackageInternalType_IsVisibleToDelegateInAnotherFile() {
        const consumer = `package Demo

internal delegate Read(value Hidden) Hidden;`
        const hidden = `package Demo

internal class Hidden {}`
        AssertNoErrors([]string{consumer, hidden})
    }

    @Fact
    func UnrelatedFileImport_DoesNotMakeDelegateReferenceAmbiguous() {
        const left = `package Left

class Result {}`
        const right = `package Right

class Result {}`
        const delegates = `package Consumer
import Left

delegate Read() Result;`
        const unrelated = `package Unrelated
import Right

class Marker {}`
        AssertNoErrors([]string{right, left, unrelated, delegates})
    }

    @Fact
    func MissingDelegateSignatureType_StillReportsUndefinedType() {
        const source = `package Demo

delegate Read(value Missing) Missing;`
        let errors = Errors([]string{source}).ToArray()
        Assert.Contains(errors, (d Diagnostic) -> d.Id == "GS0113")
    }

    @Fact
    func AmbiguousImportedDelegateSignatureType_StillReportsAmbiguity() {
        const left = `package Left

class Result {}`
        const right = `package Right

class Result {}`
        const consumer = `package Consumer
import Left
import Right

delegate Read() Result;`
        let errors = Errors([]string{left, right, consumer}).ToArray()
        Assert.Contains(errors, (d Diagnostic) -> d.Id == "GS0496")
    }

    shared {
        private const Delegates string = `package Demo
import System.Collections.Generic

delegate Work[T ICancellation](
    cancellation ICancellation,
    values List[ConfigurationTokenResult]) Dictionary[string, ConfigurationTokenResult];
internal delegate GetResult() ConfigurationTokenResult;`

        private const Types string = `package Demo

interface ICancellation {}
internal data class ConfigurationTokenResult(Value string) {}`

        private func AssertNoErrors(sources[]string) -> Assert.DoesNotContain(Errors(sources), (_ Diagnostic) -> true)

        private func Errors(sources[]string) IEnumerable[Diagnostic] {
            let trees = sources.Select((source string) -> SyntaxTree.Parse(SourceText.From(source))).ToArray()
            let compilation = Compilation(trees){IsLibrary = true}
            return compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
        }
    }
}
