// <copyright file="Issue4584UnscopedRefReferenceAssemblyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Xunit
import GSharp.Core.CodeAnalysis.Binding
import System.Diagnostics.CodeAnalysis
import System.Reflection
import System.Reflection.Emit

/// Issue #4584: an SDK build binds against the reference assembly
/// (`System.Runtime`), whose `UnscopedRefAttribute` has a different
/// assembly name and key than the host runtime's (`System.Private.CoreLib`).
/// Recognition compared against the host identity only, so a genuine
/// `@UnscopedRef` was ignored and GS0589 fired on the annotated member
/// (migrated `test/Core.Tests` failed to compile). The expectation never
/// names the load context: the same source must bind for every closure.
open class Issue4584UnscopedRefReferenceAssemblyTests {
    @Theory
    @MemberData("Closures")
    func AnnotatedMembers_DoNotReportGS0589(closure string) {
        let diagnostics = EmitDiagnostics(closure, Annotated)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0589")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Theory
    @MemberData("Closures")
    func UnannotatedMember_StillReportsGS0589(closure string) {
        let diagnostics = EmitDiagnostics(closure, Unannotated)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0589")
    }

    @Fact
    func SameNamedAttributeWithoutThePlatformKey_IsNotRecognized() {
        let assembly = AssemblyBuilder.DefineDynamicAssembly(AssemblyName("System.Runtime"), AssemblyBuilderAccess.Run)
        let type = assembly
            .DefineDynamicModule("m")
            .DefineType("System.Diagnostics.CodeAnalysis.UnscopedRefAttribute", TypeAttributes.Public)
            .CreateType()
        Assert.False(KnownAttributes.IsUnscopedRef(type))
        Assert.True(KnownAttributes.IsUnscopedRef(typeof(UnscopedRefAttribute)))
    }

    @Fact
    func TargetingPack_IsAvailable() {
        Assert.True(
            TargetingPackDirectories().Any(),
            "no Microsoft.NETCore.App.Ref targeting pack was available; the reference-assembly closure is what discriminates this fix"
        )
    }

    shared {
        private const Annotated string = `package P
import System.Diagnostics.CodeAnalysis

ref struct S {
    private var value int32

    @UnscopedRef
    prop this[i int32] ref int32 {
        get {
            return ref this.value
        }
    }

    @UnscopedRef
    prop Slot ref int32 -> this.value

    @UnscopedRef
    func Get() ref int32 {
        return ref this.value
    }
}`

        private const Unannotated string = `package P

ref struct S {
    private var value int32

    func Get() ref int32 {
        return ref this.value
    }
}`

        func Closures() sequence[[]object] {
            yield[]object{"host runtime"}
            for pack in TargetingPackDirectories() {
                yield[]object{pack}
            }
        }

        private func EmitDiagnostics(closure string, source string) List[Diagnostic] {
            using let resolver = if closure == "host runtime" {
                ReferenceResolver.Default()
            } else {
                ReferenceResolver.WithReferences(Directory.EnumerateFiles(closure, "*.dll"))
            }
            let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
            using let stream = MemoryStream()
            return compilation.Emit(stream).Diagnostics.ToList()
        }

        private func TargetingPackDirectories() sequence[string] {
            let runtimeDirectory string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            let dotnetRoot string? = Directory.GetParent(runtimeDirectory ?? string.Empty)?.Parent?.Parent?.FullName
            if dotnetRoot == nil {
                yield break
            }
            let packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            if !Directory.Exists(packsRoot) {
                yield break
            }
            for version in Directory.EnumerateDirectories(packsRoot).OrderBy((d string) -> d, StringComparer.Ordinal) {
                let refDirectory = Path.Combine(version, "ref", "net${Environment.Version.Major}.0")
                if Directory.Exists(refDirectory) {
                    yield refDirectory
                }
            }
        }
    }
}
