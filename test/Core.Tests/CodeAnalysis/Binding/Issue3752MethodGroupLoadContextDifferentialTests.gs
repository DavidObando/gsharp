// <copyright file="Issue3752MethodGroupLoadContextDifferentialTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Issue #3752 (issue #3705, family 3; #3684's "F13") — a method-group
/// conversion at a native function type whose signature mentions a type
/// projected from the compilation's (cref:System.Reflection.MetadataLoadContext).
///
/// `FunctionTypeSymbol.BuildClrType` gives `(Type) -> Type` its
/// CLR shape by closing the <em>live</em> `System.Func`2` over the
/// parameter and return symbols' `ClrType`s. Under any `/reference:`
/// compile those are MLC types, and
/// `typeof(Func<,>).MakeGenericType(mlcType, mlcType)` cannot yield
/// a `RuntimeType` — the runtime materialises a
/// `System.Reflection.Emit.TypeBuilderInstantiation` instead, whose
/// `GetMethod("Invoke")` throws (cref:NotSupportedException).
/// `ConversionClassifier.BindClrMethodGroupConversion` reflected
/// `Invoke` directly, so it saw "no invoke method" and reported GS0218
/// for <em>every</em> method group at a function type over an imported type,
/// while the identical conversion over host runtime types
/// (`(string) -> bool`) succeeded.
///
/// Shaped like `Issue3705LoadContextDifferentialTests`: the reflection
/// context never appears on the right-hand side of an expectation. Each row
/// states one answer and it is asserted for both the default (host runtime)
/// resolver and the MetadataLoadContext resolver. The rows expecting
/// `GS0218` are the anti-vacuity half — they prove the fixture can still
/// observe the diagnostic it is asserting the absence of elsewhere.
open class Issue3752MethodGroupLoadContextDifferentialTests {
    /// The invariant: whether a method group converts to a function type is a
    /// property of the signature, not of the reflection context the
    /// signature's types were materialised in.
    /// @param label The row label (diagnostic aid only).
    /// @param body The G# declaration under test.
    /// @param expected The single expected answer, for both contexts.
    @Theory
    @MemberData("Rows")
    func SameAnswer_ForRuntimeResolver_AndMetadataLoadContextResolver(label string, body string, expected string) {
        let source = `package P
import System

` + body
        let hostAnswer = Compile(source, mlc: false)
        let mlcAnswer = Compile(source, mlc: true)
        Assert.True(expected == hostAnswer, "[$label] host resolver: expected '$expected', got '$hostAnswer'")
        Assert.True(
            expected == mlcAnswer,
            "[$label] MetadataLoadContext resolver: expected '$expected', got '$mlcAnswer'"
        )
    }

    /// The hazard this family exists for, pinned directly: a native function
    /// type over an MLC-projected type is not a `RuntimeType` at all, and
    /// reflecting `Invoke` off it throws rather than answering. This is
    /// why the site had to read its signature through
    /// (cref:ClrLoadContext.TryGetDelegateSignature), and it doubles as
    /// proof that this fixture's MLC really is a distinct reflection context.
    @Fact
    func FunctionTypeOverProjectedType_HasNoReachableInvoke() {
        using let resolver = MetadataLoadContextResolver()
        let mlcType = resolver.MapClrTypeToReferences(typeof(Type))
        Assert.NotNull(mlcType)
        Assert.False(
            object.ReferenceEquals(typeof(Type), mlcType),
            "the fixture is not exercising two reflection contexts"
        )
        // What `FunctionTypeSymbol.BuildClrType` produces for `(Type) -> Type`.
        let functionClr = typeof(Func[_, _]).MakeGenericType(mlcType, mlcType)
        Assert.False(functionClr.IsGenericTypeDefinition)
        Assert.Throws[NotSupportedException](
            func () object? {
                return functionClr.GetMethod("Invoke")
            }
        )
        // ... and what the funnel answers for the same type.
        Assert.True(ClrLoadContext.TryGetDelegateSignature(functionClr, out var parameters, out var returnType))
        Assert.Equal("System.Type", Assert.Single(parameters).FullName)
        Assert.Equal("System.Type", returnType.FullName)
        // The host-context twin, for contrast: an ordinary RuntimeType.
        Assert.NotNull(typeof((Type) -> Type).GetMethod("Invoke"))
    }

    shared {
        /// The differential table: `(label, G# source, the one expected
        /// diagnostic set)`, with the reflection context deliberately absent
        /// from the expectation.
        /// @returns The xUnit member-data rows.
        func Rows() TheoryData[string, string, string] {
            let data = TheoryData[string, string, string]()
            let Add = func (label string, body string, expected string) {
                data.Add(label, body, expected)
            }
            // --- Signatures over `System.Type`, which every MLC projects. These
            // are the defect: all of them reported GS0218 under the MLC resolver
            // and bound cleanly under the host one.
            Add("static-projected-both-positions", `func probe() {
    let g (Type) -> Type = Nullable.GetUnderlyingType
}`, "<none>")
            Add("static-projected-nullable-spelling", `func probe() {
    let g (Type?) -> Type? = Nullable.GetUnderlyingType
}`, "<none>")
            Add("static-projected-optional-function-type", `func probe() {
    let g ((Type?) -> Type?)? = Nullable.GetUnderlyingType
}`, "<none>")
            // Return position alone is enough: `Func<Type>` is just as unreachable
            // a closure as `Func<Type, Type>`.
            Add("instance-projected-return-only", `func probe(t Type) {
    let g () -> Type = t.MakeArrayType
}`, "<none>")
            // Parameter position alone, with a primitive return.
            Add("instance-projected-parameter-only", `func probe(t Type) {
    let g (Type) -> bool = t.IsAssignableFrom
}`, "<none>")
            // --- The control that always worked: no projected type in the
            // signature, so `BuildClrType` closes `Func<string, bool>` over host
            // runtime types and produces a real `RuntimeType`.
            Add("control-no-projected-type", `func probe(t string) {
    let g (string) -> bool = t.StartsWith
}`, "<none>")
            // --- Anti-vacuity: genuinely inapplicable method groups must STILL be
            // rejected, in both contexts. Without these the rows above could be
            // satisfied by a binder that stopped diagnosing anything.
            Add("reject-arity-mismatch", `func probe() {
    let g (Type, Type) -> Type = Nullable.GetUnderlyingType
}`, "GS0218")
            Add("reject-return-mismatch", `func probe() {
    let g (Type) -> string = Nullable.GetUnderlyingType
}`, "GS0218")
            Add("reject-parameter-mismatch", `func probe() {
    let g (string) -> Type = Nullable.GetUnderlyingType
}`, "GS0218")
            return data
        }

        private func Compile(source string, mlc bool) string {
            let resolver ReferenceResolver? = if mlc {
                MetadataLoadContextResolver()
            } else {
                default(ReferenceResolver?)
            }
            try {
                let tree = SyntaxTree.Parse(SourceText.From(source))
                let globalScope = if resolver != nil {
                    Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
                } else {
                    Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
                }
                let program = Binder.BindProgram(globalScope, resolver)
                let ids = globalScope
                    .Diagnostics
                    .AddRange(program.Diagnostics)
                    .Where((d Diagnostic) -> d.IsError)
                    .Select((d Diagnostic) -> d.Id)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy((id string) -> id, StringComparer.Ordinal)
                    .ToArray()
                return if ids.Length == 0 {
                    "<none>"
                } else {
                    string.Join(", ", ids)
                }
            } finally {
                resolver?.Dispose()
            }
        }

        /// The reference-assembly-backed resolver `gsc` uses on every real
        /// `/reference:` compile.
        /// @returns A MetadataLoadContext-backed resolver.
        private func MetadataLoadContextResolver() ReferenceResolver {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            let refPaths = Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            return ReferenceResolver.WithReferences(refPaths)
        }
    }
}
