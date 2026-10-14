// <copyright file="Issue2394SourceTypeMemberAccessPrecedenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.IO
import System.Linq
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit

/// Issue #2394: imports are bound compilation-wide (not scoped per source
/// file/tree — see `Binder.cs`'s single shared `scope.TryImport`
/// loop over every syntax tree), so an `import Some.Namespace` in ONE
/// file makes that namespace's imported CLR types visible while binding EVERY
/// OTHER file in the same compilation. Several member-access/expression
/// receiver-resolution code paths checked `scope.TryLookupImportedClass`
/// (imported CLR type) BEFORE `scope.TryLookupTypeAlias` (same-
/// compilation source type: struct/enum/interface) — the opposite precedence
/// from (cref:Binder.LookupType(GSharp.Core.CodeAnalysis.Syntax.NameExpressionSyntax, bool))
/// (used for type-clause positions), which has always preferred the source
/// type. So a same-simple-name CLR type imported via some UNRELATED file
/// could incorrectly shadow a compilation's own type's static member access,
/// static field/property write, "color color" resolution, and static
/// event/field compound assignment.
///
/// This was discovered via the real Oahu.Core migration: `Crc32.gs`
/// (package `Oahu.Core.Cryptography`) does a self-qualified static
/// access `Crc32.Table`/`Crc32.Polynomial`, while an unrelated file
/// in the SAME compilation (package `Oahu.Core`) has
/// `import Oahu.Aux` — a namespace that (via a transitive reference)
/// contains an unrelated imported `Oahu.Aux.Crc32 : HashAlgorithm` CLR
/// type with no `Table`/`Polynomial` members, causing
/// `GS0158 Cannot find member`.
///
/// These tests use the always-available `System.IO.Path` CLR type as
/// the "unrelated imported collider" (no custom reference assembly needed),
/// paired with a same-simple-name SOURCE `Path` struct declared in a
/// SEPARATE file that itself never imports `System.IO` — reproducing
/// the exact compilation-wide leak shape.
open class Issue2394SourceTypeMemberAccessPrecedenceTests {
    @Fact
    func StaticFieldRead_SourceStructWins_OverImportLeakedFromUnrelatedFile() {
        // File A never mentions `Path`, but imports System.IO — leaking
        // System.IO.Path (a CLR type) into the whole compilation's scope.
        // File B declares its OWN `Path` struct with a static field that does
        // NOT exist on System.IO.Path, and reads it via a plain (non-color-
        // color) static member access. Before the fix, `Path.Kind` resolved
        // to System.IO.Path (checked first) and failed with
        // "cannot find member Kind"; after the fix, the source struct wins.
        const fileA = `package P
import System.IO

class Noise {
}`
        const fileB = `package P

struct Path {
    shared {
        var Kind string = "gs-path"
    }
}

class Consumer {
    func Get() string {
        return Path.Kind
    }
}`
        Assert.Empty(Bind(fileA, fileB))
    }

    @Fact
    func StaticFieldWrite_SourceStructWins_OverImportLeakedFromUnrelatedFile() {
        // Same leak shape as above, but exercising the WRITE path
        // (BindFieldAssignmentExpression's "Stream B" vs. ADR-0053 static
        // struct-field ordering).
        const fileA = `package P
import System.IO

class Noise {
}`
        const fileB = `package P

struct Path {
    shared {
        var Kind string = ""
    }
}

class Consumer {
    func Set() {
        Path.Kind = "changed"
    }
}`
        Assert.Empty(Bind(fileA, fileB))
    }

    @Fact
    func StaticInterfaceFieldRead_SourceInterfaceWins_OverImportLeakedFromUnrelatedFile() {
        // Same leak shape, but for a same-simple-name source INTERFACE
        // (ADR-0089 / issue #1030 static interface field) rather than struct.
        const fileA = `package P
import System.IO

class Noise {
}`
        const fileB = `package P

interface Path {
    shared {
        var Kind string
    }
}

class Consumer {
    func Get() string {
        return Path.Kind
    }
}`
        Assert.Empty(Bind(fileA, fileB))
    }

    @Fact
    func ColorColor_SourceStructWins_OverImportLeakedFromUnrelatedFile() {
        // TryResolveColorColorType path: a field named `Path` shadows BOTH
        // the imported System.IO.Path (leaked from fileA) and this file's own
        // `Path` struct. `Kind` is a static field of the source struct but
        // not a member of System.IO.Path at all, so before the fix the
        // color-color resolution matched (and stalled on) the wrong,
        // import-leaked type and the access fell through to the (incorrect)
        // instance-field interpretation, which then failed to find `Kind` on
        // a plain string.
        const fileA = `package P
import System.IO

class Noise {
}`
        const fileB = `package P

struct Path {
    shared {
        var Kind string = "gs-path"
    }
}

class Probe {
    var Path string = ""

    func Get() string {
        return Path.Kind
    }
}`
        Assert.Empty(Bind(fileA, fileB))
    }

    @Fact
    func StaticEventCompoundAssignment_SourceStructWins_OverImportLeakedFromUnrelatedFile() {
        // ExpressionBinder.Async's event-subscription/compound-assignment
        // receiver resolution: same leak shape, but for `Path.Tick +=
        // handler` (a static event subscription) on a source struct.
        const fileA = `package P
import System.IO

class Noise {
}`
        const fileB = `package P
import System

struct Path {
    shared {
        event Tick Action
    }
}

func handler() { }

func Subscribe() {
    Path.Tick += handler
}`
        Assert.Empty(Bind(fileA, fileB))
    }

    @Fact
    func StaticFieldCompoundAssignment_SourceStructWins_OverImportLeakedFromUnrelatedFile() {
        // Same leak shape, compound-assignment (`+=`) to a plain static
        // field rather than an event — also routed through
        // ExpressionBinder.Async's receiver resolution.
        const fileA = `package P
import System.IO

class Noise {
}`
        const fileB = `package P

struct Path {
    shared {
        var Count int32
    }
}

func Bump() {
    Path.Count += 1
}`
        Assert.Empty(Bind(fileA, fileB))
    }

    @Fact
    func NoCollision_ImportedClrType_StillResolvesNormally() {
        // Negative control: with no same-simple-name source type anywhere in
        // the compilation, a qualified CLR static member access must
        // continue to resolve against the imported type exactly as before
        // the fix (no regression to the ordinary imported-class path).
        const source = `package P
import System.IO

func Combine(a string, b string) string {
    return Path.Combine(a, b)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func NoCollision_SamePackage_SourceStructAlone_StillResolves() {
        // Negative control: a source struct with no colliding imported type
        // anywhere in the compilation must keep resolving exactly as before.
        const source = `package P

struct Counter {
    shared {
        var Value int32 = 7
    }
}

func Get() int32 {
    return Counter.Value
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func OahuCoreRegression_Crc32SelfQualifiedStaticAccess_CompilesDespiteUnrelatedImportedCrc32Elsewhere() {
        // Exact regression for the real Oahu.Core migration failure: an
        // UNRELATED imported CLR type `Oahu.Aux.Crc32` (deriving from
        // HashAlgorithm, no Table/Polynomial members) is visible via
        // `import Oahu.Aux` in some OTHER file of the same compilation
        // (`OtherFile.gs`), while `Cryptography/Crc32.gs` declares its own
        // source `Crc32` class with self-qualified static field access
        // (`Crc32.Table`, `Crc32.Polynomial`). Before the #2394 fix, the
        // leaked import caused these self-qualified accesses to resolve
        // against the wrong (imported) `Crc32` and fail with
        // "cannot find member Table"/"cannot find member Polynomial".
        let libraryPath = EmitCSharpLibrary(
            "OahuCoreRegression_Crc32SelfQualifiedStaticAccess_CompilesDespiteUnrelatedImportedCrc32Elsewhere",
            `using System.Security.Cryptography;

namespace Oahu.Aux
{
    public sealed class Crc32 : HashAlgorithm
    {
        protected override void HashCore(byte[] array, int ibStart, int cbSize) { }

        protected override byte[] HashFinal() => new byte[4];

        public override void Initialize() { }
    }
}`
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        const otherFileSource = `package Oahu.Core

import Oahu.Aux

class OtherFile {
    shared {
        func Noop() void {
        }
    }
}`
        const crc32Source = `package Oahu.Core.Cryptography

internal class Crc32 {
    shared {
        private const Polynomial uint32 = 3988292384U
        private let Table []uint32 = [256]uint32

        init {
            var value uint32
            var temp uint32
            for var i uint32 = uint32(0); int64(i) < int64(Crc32.Table.Length); i++ {
                value = uint32(0)
                temp = i
                for var j uint8 = uint8(0); j < uint8(8); j++ {
                    if ((value ^ temp) & uint32(0x1)) != uint32(0) {
                        value = value >> 1 ^ Crc32.Polynomial
                    } else {
                        value >>= 1
                    }
                    temp >>= 1
                }
                Crc32.Table[i] = value
            }
        }

        func ComputeChecksum(bytes []uint8) uint32 {
            var crc uint32 = uint32(0)
            crc ^= UInt32.MaxValue
            for var i = 0; i < bytes.Length; i++ {
                let index = uint8((crc ^ uint32(bytes[i])))
                crc = crc >> 8 ^ Crc32.Table[index]
            }
            crc ^= UInt32.MaxValue
            return crc
        }
    }
}`
        let consumer = GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(otherFileSource)),
            GsSyntaxTree.Parse(SourceText.From(crc32Source))
        )
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    shared {
        private func EmitCSharpLibrary(caseName string, source string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2394", caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "CSharpLib2394.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "CSharpLib2394",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }

        private func Bind(sources ...string) ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic] {
            let trees = sources.Select((s string) -> GsSyntaxTree.Parse(SourceText.From(s))).ToImmutableArray()
            for tree in trees {
                if tree.Diagnostics.Any() {
                    return tree.Diagnostics
                }
            }
            let globalScope = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(previous: nil, trees)
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
