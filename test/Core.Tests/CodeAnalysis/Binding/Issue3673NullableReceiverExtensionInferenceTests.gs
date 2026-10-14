// <copyright file="Issue3673NullableReceiverExtensionInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #3673: an imported generic extension method whose `this`
/// parameter is `Nullable<T>` must infer `T` from a value-typed
/// nullable receiver even when no user argument mentions `T`. The
/// extension-call argument vector presents slot 0 as
/// `NullableTypeSymbol.ClrType`, which is the *underlying* CLR type, so
/// the binder additionally retries with the lifted `Nullable<T>`
/// shape. This is what `Gsharp.Extensions.Optional.OrThrow` needs.
open class Issue3673NullableReceiverExtensionInferenceTests {
    @Fact
    func ReceiverOnlyInference_ValueTypedNullable_Binds() {
        const source = `package Probe
import GSharp.Core.Tests.Fixtures

func Run() {
    let v int32? = 7
    let unwrapped = v.UnwrapOrThrow3673("missing")
}`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func ReceiverOnlyInference_ReferenceTypedNullable_Binds() {
        const source = `package Probe
import GSharp.Core.Tests.Fixtures

func Run() {
    let s string? = "x"
    let unwrapped = s.UnwrapOrThrow3673("missing")
}`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func ArgumentDrivenInference_ValueTypedNullable_StillBinds() {
        const source = `package Probe
import GSharp.Core.Tests.Fixtures

func Run() {
    let v int32? = 7
    let value = v.UnwrapOrElse3673(1)
}`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func UnderlyingTypedExtension_OnNullableReceiver_StillBinds() {
        // The lifted retry runs only after the unlifted receiver shape has
        // already failed, so an extension declared over the underlying value
        // type keeps binding exactly as it did before issue #3673.
        const source = `package Probe
import GSharp.Core.Tests.Fixtures

func Run() {
    let v int32? = 7
    let doubled = v.Double3673()
}`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func UnknownExtensionName_OnNullableReceiver_StillReportsError() {
        const source = `package Probe
import GSharp.Core.Tests.Fixtures

func Run() {
    let v int32? = 7
    let missing = v.NoSuchExtension3673("missing")
}`
        Assert.Contains(BindDiagnostics(source), (d Diagnostic) -> d.IsError)
    }

    shared {
        private func AssertBindsWithoutErrors(source string) -> Assert.DoesNotContain(
            BindDiagnostics(source),
            (d Diagnostic) -> d.IsError
        )

        private func BindDiagnostics(source string) ImmutableArray[Diagnostic] {
            // Load the test assembly (which carries the issue #3673 fixture) plus
            // the BCL through a MetadataLoadContext, matching how the migrated
            // Extensions.Tests app sees Gsharp.Extensions.dll.
            let paths List[string] = List[string]{typeof(Issue3673NullableReceiverExtensions).Assembly.Location}
            if AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string tpa && !string.IsNullOrEmpty(tpa) {
                paths.AddRange(
                    tpa.Split(Path.PathSeparator).Where((p string) -> !string.IsNullOrWhiteSpace(p) && File.Exists(p))
                )
            }
            using let resolver = ReferenceResolver.WithReferences(paths.Distinct(StringComparer.OrdinalIgnoreCase))
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = Binder.BindProgram(globalScope, resolver)
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }
    }
}
