// <copyright file="Issue1354NullabilityRoundTripEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #1354: gsc→gsc nullability round-trip. After flipping the import
/// default so unannotated/oblivious imported reference types are nullable, the
/// emitter MUST stamp complete nullability metadata on every emitted member
/// (a type-level `[NullableContextAttribute(1)]` plus per-field/property
/// `[NullableAttribute]` for any position that deviates from the non-null
/// default). These tests compile a G# library, then re-read its fields and
/// properties through the same (cref:System.Reflection.MetadataLoadContext)
/// path that (cref:ClrNullability) uses at bind time, and assert that:
/// - a non-null reference field/property re-reads as non-null;
/// - a `T?` reference field/property re-reads as nullable;
/// - a `List[string?]` field re-reads with its inner element nullable.
/// Without the emit-completeness change the absent attribute would be re-read as
/// nullable (per the new default) and a non-null field would silently flip.
open class Issue1354NullabilityRoundTripEmitTests {
    @Fact
    func NonNullReferenceField_RoundTripsAsNonNull() {
        WithCompiledHolder(
            (holder Type) -> {
                let field = holder.GetField("NonNullField")!!
                let sym = ClrNullability.GetFieldTypeSymbol(field)
                Assert.IsNotType[NullableTypeSymbol](sym)
                Assert.Same(TypeSymbol.String, sym)
            }
        )
    }

    @Fact
    func NullableReferenceField_RoundTripsAsNullable() {
        WithCompiledHolder(
            (holder Type) -> {
                let field = holder.GetField("MaybeField")!!
                let sym = ClrNullability.GetFieldTypeSymbol(field)
                let nullable = Assert.IsType[NullableTypeSymbol](sym)
                Assert.Same(TypeSymbol.String, nullable.UnderlyingType)
            }
        )
    }

    @Fact
    func ListOfNullableElementField_RoundTripsWithInnerNullable() {
        WithCompiledHolder(
            (holder Type) -> {
                let field = holder.GetField("ListField")!!
                let sym = ClrNullability.GetFieldTypeSymbol(field)
                // Outer List is non-null → NullabilityAnnotatedTypeSymbol (not Nullable).
                let annotated = Assert.IsType[NullabilityAnnotatedTypeSymbol](sym)
                // Inner element string? must re-read as nullable.
                let elem = annotated.GetTypeArgumentSymbol(0)
                let nullableElem = Assert.IsType[NullableTypeSymbol](elem)
                Assert.Same(TypeSymbol.String, nullableElem.UnderlyingType)
            }
        )
    }

    @Fact
    func NonNullReferenceProperty_RoundTripsAsNonNull() {
        WithCompiledHolder(
            (holder Type) -> {
                let prop = holder.GetProperty("NonNullProp")!!
                let sym = ClrNullability.GetPropertyTypeSymbol(prop)
                Assert.IsNotType[NullableTypeSymbol](sym)
                Assert.Same(TypeSymbol.String, sym)
            }
        )
    }

    @Fact
    func NullableReferenceProperty_RoundTripsAsNullable() {
        WithCompiledHolder(
            (holder Type) -> {
                let prop = holder.GetProperty("MaybeProp")!!
                let sym = ClrNullability.GetPropertyTypeSymbol(prop)
                let nullable = Assert.IsType[NullableTypeSymbol](sym)
                Assert.Same(TypeSymbol.String, nullable.UnderlyingType)
            }
        )
    }

    shared {
        private func WithCompiledHolder(assert(Type) -> void) {
            const source = `package Probe
import System.Collections.Generic

class Holder {
    var NonNullField string
    var MaybeField string?
    var ListField List[string?]
    prop NonNullProp string { get; set }
    prop MaybeProp string? { get; set }
}`
            let dllPath = CompileLibrary(source)
            try {
                let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                let resolver = PathAssemblyResolver(Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath}))
                using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
                let asm = mlc.LoadFromAssemblyPath(dllPath)
                let holder = asm.GetType("Probe.Holder") ??
                    throw InvalidOperationException("Probe.Holder not found in emitted assembly.")
                assert(holder)
            } finally {
                TryCleanup(dllPath)
            }
        }

        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1354_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch {
                // Best-effort cleanup; ignore failures.

            }
        }
    }
}
