// <copyright file="Issue4044NilTupleInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Collections.Generic
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import CSharpCompilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation
import CSharpCompilationOptions = Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions
import CSharpParseOptions = Microsoft.CodeAnalysis.CSharp.CSharpParseOptions
import CSharpSyntaxTree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree
import LanguageVersion = Microsoft.CodeAnalysis.CSharp.LanguageVersion
import MetadataReference = Microsoft.CodeAnalysis.MetadataReference
import OutputKind = Microsoft.CodeAnalysis.OutputKind
import GSharp.Core.CodeAnalysis
import Microsoft.CodeAnalysis
import System.Runtime.InteropServices

/// Issue #4044: a nil tuple element stays open during generic inference.
open class Issue4044NilTupleInferenceTests {
    @Fact
    func NilTupleElement_DoesNotFixWholeGenericArgument() {
        const source = `package P
class Asserts {
    shared {
        func Equal[T](expected T, actual T) { }
    }
}
func Receive2() (string?, bool) -> (nil, false)
func Run() {
    Asserts.Equal((nil, false), Receive2())
}`
        Assert.DoesNotContain(Compile(source), (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func FullyTypedTuple_StillContributesToGenericInference() {
        const source = `package P
class Asserts {
    shared {
        func Equal[T](expected T, actual T) { }
    }
}
func Receive2() (string?, bool) -> (nil, false)
func Run() {
    Asserts.Equal(("expected", false), Receive2())
}`
        Assert.DoesNotContain(Compile(source), (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func ImportedGeneric_NilTupleElement_UsesOtherArgumentTarget() {
        const source = `package P
import Xunit
func Receive2() (string?, bool) -> (nil, false)
func Run() {
    Assert.Equal((nil, false), Receive2())
}`
        Assert.DoesNotContain(
            CompileWithReferences(source, typeof(Assert).Assembly.Location),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
    }

    @Fact
    func ImportedGeneric_NilTupleElement_DoesNotTargetValueType() {
        const source = `package P
import Xunit
func Actual() (int32, bool) -> (1, false)
func Run() {
    Assert.Equal((nil, false), Actual())
}`
        Assert.Contains(
            CompileWithReferences(source, typeof(Assert).Assembly.Location),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
    }

    @Fact
    func ImportedExtension_NilTupleElement_SurvivesReceiverInference() {
        const source = `package P
import System.Collections.Generic
import Lib4044
func Run() {
    let values = List[(string?, bool)]()
    values.Add(("x", false))
    let found = values.Includes((nil, false))
}`
        Assert.DoesNotContain(
            CompileWithReferences(source, ImportedLibraryPath),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
    }

    /// A nil tuple element closed against a NON-NULL sibling through an
    /// unannotated `params T[]`: `T` is inferred as
    /// `(string, bool)`, and `nil -> string` is rejected — exactly
    /// as the same call to a G#-declared `func AnyEqual[T](values ...T)`
    /// is ((cref:GSharpParamsGeneric_NilTupleElement_AgainstANonNullSibling_IsRejected)).
    ///
    /// Issue #4361 reversed this row. It compiled only because the open
    /// `T` slot's ABSENT nullability byte was stamped onto the inferred
    /// argument — `T?` under ADR-0136 and then `T!` under ADR-0186
    /// (the issue #4322 fix). ADR-0186 §2 says an open slot's nullability
    /// arrives with the type argument, however silent the declaration is,
    /// and that stamp is what gave every unannotated generic's result a
    /// nested platform type (`Array.Empty[string]()` as `[]!string!`)
    /// and broke the nightly self-migration corpus. What #4044 is about still
    /// holds: the nil element stays open and `T` closes against the
    /// sibling rather than being fixed as `(nil, bool)`; the error is the
    /// element conversion, not an inference failure.
    @Fact
    func ImportedParamsGeneric_NilTupleElement_AgainstANonNullSibling_IsRejected_LikeAGSharpGeneric() {
        const source = `package P
import Lib4044
func Run() {
    let found = Extensions.AnyEqual((nil, false), ("x", false))
}`
        // Pinned: this row is the behaviour ADR-0186's platform-types mode
        // changes. Under `--nullability=enabled` ADR-0136's widening still
        // applies and the call compiles — the control below.
        {
            using let _ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
            AssertRejectsOnlyTheNilElement(
                CompileWithReferences(source, NullabilityMode.PlatformTypes, ImportedLibraryPath),
                "(string, bool)"
            )
        }
        {
            using let _ = NullabilityOptions.Enter(NullabilityMode.Enabled)
            Assert.DoesNotContain(
                CompileWithReferences(source, NullabilityMode.Enabled, ImportedLibraryPath),
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
            )
        }
    }

    /// The G#-declared control for the imported row above.
    @Fact
    func GSharpParamsGeneric_NilTupleElement_AgainstANonNullSibling_IsRejected() {
        const source = `package P
class Extensions {
    shared {
        func AnyEqual[T](values ...T) bool { return true }
    }
}
func Run() {
    let found = Extensions.AnyEqual((nil, false), ("x", false))
}`
        AssertRejectsOnlyTheNilElement(Compile(source), "(string, bool)")
    }

    /// The same parity for a nil element whose OTHER element still drives
    /// inference: `U` is inferred from the `1`, `T` from the
    /// non-null `seed`, so the nil element meets a non-null
    /// `string` — see the row above for why that is now rejected.
    @Fact
    func ImportedParamsGeneric_NilTupleElement_PreservesOtherElementInference() {
        const source = `package P
import Lib4044
func Run() {
    let found = Extensions.AnyPair("x", (nil, 1))
}`
        {
            using let _ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
            AssertRejectsOnlyTheNilElement(
                CompileWithReferences(source, NullabilityMode.PlatformTypes, ImportedLibraryPath),
                "(string, int32)"
            )
        }
        {
            using let _ = NullabilityOptions.Enter(NullabilityMode.Enabled)
            Assert.DoesNotContain(
                CompileWithReferences(source, NullabilityMode.Enabled, ImportedLibraryPath),
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
            )
        }
    }

    /// The nil element may be carried through a nilable sibling, which is the
    /// shape #4044 exists for, and that still compiles through an unannotated
    /// `params T[]`.
    @Fact
    func ImportedParamsGeneric_NilTupleElement_UsesANilableSiblingArgument() {
        const source = `package P
import Lib4044
func Receive2() (string?, bool) -> (nil, false)
func Run() {
    let found = Extensions.AnyEqual((nil, false), Receive2())
}`
        Assert.DoesNotContain(
            CompileWithReferences(source, ImportedLibraryPath),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
    }

    shared {
        private let ImportedLibraryPath string = EmitCSharpLibrary()

        /// Asserts the call failed only at the nil element's conversion, and in
        /// the right DIRECTION: the rejected source is the `(nil, …)` tuple
        /// and the required type is the sibling-inferred
        /// [`inferredTarget`](paramref). The old #4044 failure fixed `T`
        /// as `(nil, bool)` and rejected the sibling with the same diagnostic
        /// ids, so the ids alone cannot tell the two apart.
        private func AssertRejectsOnlyTheNilElement(
            diagnostics ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic],
            inferredTarget string
        ) {
            let errors = diagnostics.Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
                .ToArray()
            Assert.NotEmpty(errors)
            Assert.All(
                errors,
                (error GSharp.Core.CodeAnalysis.Diagnostic) -> {
                    Assert.True(
                        (error.Id is "GS0154" or "GS0155"),
                        "expected only the nil element's conversion to be rejected, got ${error.Id}: ${error.Message}"
                    )
                    // Either the whole tuple (`'(nil, bool)'` -> `'(string, bool)'`,
                    // the G#-generic spelling) or just its element (`'nil'` ->
                    // `'string'`, the imported-params spelling) — but always the
                    // nil side as SOURCE and the sibling-inferred side as TARGET.
                    let elementTarget = inferredTarget.Substring(1, inferredTarget.IndexOf(',') - 1)
                    let (source, target) = SourceAndTarget(error)
                    Assert.True(
                        (source.StartsWith("(nil,", StringComparison.Ordinal) || source == "nil") &&
                            (target == inferredTarget || target == elementTarget),
                        "expected a nil source rejected against '$inferredTarget' (or its '$elementTarget' element), got ${error.Id}: ${error.Message}"
                    )
                }
            )
        }

        // GS0155: "Cannot convert type 'S' to 'T'."; GS0154: "Parameter 'p'
        // requires a value of type 'T' but was given a value of type 'S'."
        private func SourceAndTarget(error GSharp.Core.CodeAnalysis.Diagnostic)(Source string, Target string) {
            let quoted = error.Message.Split('\'').Where((_ string, index int32) -> index % 2 == 1).ToArray()
            return if error.Id == "GS0154" {
                (quoted[^1], quoted[^2])
            } else {
                (quoted[0], quoted[1])
            }
        }

        private func Compile(source string) ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic] {
            let compilation = GSharp
                .Core
                .CodeAnalysis
                .Compilation
                .Compilation(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))){
                IsLibrary = true
            }
            return EmittedOracle.CompileDiagnostics(compilation)
        }

        private func CompileWithReferences(source string, additionalReferences ...string) ImmutableArray[
            GSharp.Core.CodeAnalysis.Diagnostic
        ] -> CompileWithReferences(source, mode: nil, additionalReferences)

        private func CompileWithReferences(
            source string,
            mode NullabilityMode?,
            additionalReferences ...string
        ) ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic] {
            let runtimeDirectory = RuntimeEnvironment.GetRuntimeDirectory()
            let references = ReferenceResolver.WithReferences(
                Directory.GetFiles(runtimeDirectory, "*.dll").Concat(additionalReferences)
            )
            let compilation = GSharp
                .Core
                .CodeAnalysis
                .Compilation
                .Compilation(references, GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))){
                IsLibrary = true
            }
            if mode is {} pinned {
                compilation.Nullability = pinned
            }
            return compilation.BoundProgram.Diagnostics
        }

        private func EmitCSharpLibrary() string {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue4044Binding")
            Directory.CreateDirectory(outputDirectory)
            let libraryPath = Path.Combine(outputDirectory, "Lib4044.dll")
            const source = `using System.Collections.Generic;

namespace Lib4044
{
    public static class Extensions
    {
        public static bool Includes<T>(this List<T> values, T value)
            => values.Contains(value);

        public static bool AnyEqual<T>(params T[] values)
            => values.Length > 1;

        public static bool AnyPair<T, U>(T seed, params (T, U)[] values)
            => values.Length > 0;
    }
}`
            let syntaxTree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths.Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Lib4044",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(libraryPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }
    }
}
