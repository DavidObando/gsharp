// <copyright file="Issue3873ByRefLikeBackingFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Issue #3873: GS0219 (issue #367 / ADR-0058 — a by-ref-like value cannot escape
/// to the heap) only ever saw fields the user SPELLED OUT. A compiler-synthesized
/// backing field — an auto-property's `<P>k__BackingField` — went
/// unchecked, so `struct X { prop Values Span[int32] }` compiled clean and
/// produced an assembly the CLR cannot load at all:
/// `TypeLoadException: A ByRef or ByRef-like type cannot be used as the type
/// for an instance field in a non-ByRef-like type`, thrown out of
/// `GetExportedTypes()` — which is exactly the call xunit discovery makes.
///
/// That mattered beyond one member shape. In #3869 this was the SECOND
/// independent guard to fail on the same hazard (the first being cs2gs dropping
/// the `ref` from a `ref struct`, fixed in #3872), and both failing is
/// what turned a compile error into a migrated test assembly that discovered zero
/// tests and still reported green.
///
/// The assertions below are deliberately not ILVerify-based: the failure mode is a
/// runtime type-load failure, and on this effort a defect has already passed
/// ILVerify and still thrown at load (#3764). So the illegal shapes must be
/// rejected at COMPILE time, and the legal `ref struct` shape must still
/// compile, load, and enumerate through `GetExportedTypes()`.
open class Issue3873ByRefLikeBackingFieldEmitTests {
    /// The #3873 repro itself: a non-`ref` struct whose auto-property is a
    /// `Span[T]`. Rejected at compile time, where the identical spelled-out
    /// field has always been rejected.
    @Fact
    func ByRefLikeAutoProperty_OnStruct_ReportsGS0219() {
        AssertRejected(`package P
import System
struct Holder { prop Values Span[int32] }`, "ByRefLikeAutoProperty_OnStruct_ReportsGS0219")
    }

    /// A class is never by-ref-like, so its auto-property backing field is subject
    /// to the same rule — and produces the same unloadable assembly.
    @Fact
    func ByRefLikeAutoProperty_OnClass_ReportsGS0219() {
        AssertRejected(`package P
import System
class Holder { prop Values Span[int32] }`, "ByRefLikeAutoProperty_OnClass_ReportsGS0219")
    }

    /// A USER-declared `ref struct` (not just an imported `Span[T]`) is
    /// the same hazard: the check must be about by-ref-like-ness, not about a
    /// hard-coded set of imported type names.
    @Fact
    func UserRefStructAutoProperty_OnStruct_ReportsGS0219() {
        AssertRejected(`package P
ref struct Accumulator { var Total int32 }
struct Holder { prop Slot Accumulator }`, "UserRefStructAutoProperty_OnStruct_ReportsGS0219")
    }

    /// A `shared` (static) auto-property is illegal EVEN INSIDE a
    /// `ref struct`: a static field is rooted on the heap, so there is no
    /// stack-confined container that makes it legal. The runtime distinguishes the
    /// two cases explicitly ("... as the type for a static field").
    @Fact
    func ByRefLikeSharedAutoProperty_InRefStruct_ReportsGS0219() {
        AssertRejected(`package P
import System
ref struct Holder { shared { prop Values Span[int32] } }`, "ByRefLikeSharedAutoProperty_InRefStruct_ReportsGS0219")
    }

    /// Anti-vacuity, and the load-bearing half: an INSTANCE auto-property of a
    /// by-ref-like type inside a genuine `ref struct` is legal C#/G# and must
    /// keep compiling — and the emitted assembly must still type-load and
    /// enumerate. Without this test, "always report GS0219 for a by-ref-like
    /// property" would satisfy every assertion above while breaking the one shape
    /// the language is supposed to support (ADR-0058, `samples/UserRefStruct.gs`).
    @Fact
    func ByRefLikeAutoProperty_InRefStruct_CompilesAndTheAssemblyTypeLoads() {
        let outputPath = CompileLibrary(`package P
import System
ref struct Holder { prop Values Span[int32] }`, "ByRefLikeAutoProperty_InRefStruct_CompilesAndTheAssemblyTypeLoads")
        {
            using let pe = PEReader(File.OpenRead(outputPath))
            let metadata = pe.GetMetadataReader()
            let definition = metadata
                .TypeDefinitions
                .Select(metadata.GetTypeDefinition)
                .Single((candidate TypeDefinition) -> metadata.GetString(candidate.Name) == "Holder")
            Assert.Contains(
                definition
                    .GetCustomAttributes()
                    .Select(metadata.GetCustomAttribute)
                    .Select((attribute CustomAttribute) -> AttributeTypeName(metadata, attribute)),
                (name string) -> name == "IsByRefLikeAttribute"
            )
            // The property really is backed by a field — otherwise this whole
            // test would be vacuous, since a field-less property is trivially
            // loadable.
            Assert.Contains(
                definition
                    .GetFields()
                    .Select(metadata.GetFieldDefinition)
                    .Select((field FieldDefinition) -> metadata.GetString(field.Name)),
                (name string) -> name.Contains("Values", StringComparison.Ordinal)
            )
        }
        // The CLR type loader, not the binder, is what has to accept this.
        let loadContext = AssemblyLoadContext(
            "ByRefLikeAutoProperty_InRefStruct_CompilesAndTheAssemblyTypeLoads",
            isCollectible: true
        )
        try {
            let assembly = loadContext.LoadFromAssemblyPath(outputPath)
            Assert.Contains(assembly.GetExportedTypes(), (type Type) -> type.Name == "Holder")
        } finally {
            loadContext.Unload()
        }
    }

    /// Anti-vacuity: a COMPUTED property whose type is by-ref-like has no backing
    /// field at all, so it is legal on an ordinary class and must not be reported.
    /// (An indexer cannot reach this rule by construction — G# has no auto-indexer
    /// form; a bodiless indexer is GS0371 — so there is nothing to guard there.)
    @Fact
    func ByRefLikeComputedProperty_OnClass_IsPermitted() {
        CompileLibrary(`package P
import System
class Holder {
    private let values []int32 = []int32{1, 2}
    prop Slice Span[int32] {
        get { return Span[int32](values) }
    }
}`, "ByRefLikeComputedProperty_OnClass_IsPermitted")
    }

    /// The same blind spot swallowed a managed pointer (`*T`) auto-property,
    /// which is not a field type either (ADR-0039 §4 — CLR metadata has no
    /// ELEMENT_TYPE_BYREF slot in a FieldDef signature). It used to reach the
    /// signature encoder and crash it (GS9998, an internal error); it must report
    /// the same user-facing rule the spelled-out field does (GS9006).
    @Fact
    func PointerTypedAutoProperty_ReportsFieldTypeError_NotAnInternalCrash() {
        let (exitCode, diagnostics) = Compile(
            "package P\nstruct Holder { prop Values *int32 }",
            "PointerTypedAutoProperty_ReportsFieldTypeError_NotAnInternalCrash"
        )
        Assert.True(exitCode != 0, "A pointer-typed auto-property must not compile:\n" + diagnostics)
        Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
        Assert.Contains("GS9006", diagnostics, StringComparison.Ordinal)
    }

    shared {
        private func AssertRejected(source string, testName string) {
            let (exitCode, diagnostics) = Compile(source, testName)
            Assert.True(exitCode != 0, ("$testName" + `: the source must be rejected — it emits an assembly the CLR cannot load. Output:
`) + diagnostics)
            Assert.Contains("GS0219", diagnostics, StringComparison.Ordinal)
        }

        private func CompileLibrary(source string, testName string) string {
            let directory = CreateArtifactDirectory(testName)
            let outputPath = Path.Combine(directory, "test.dll")
            let (exitCode, diagnostics) = CompileTo(source, outputPath)
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
            Assert.True(exitCode == 0, ("$testName" + `: gsc failed:
` + "$diagnostics"))
            return outputPath
        }

        private func Compile(source string, testName string)(ExitCode int32, Diagnostics string) {
            let directory = CreateArtifactDirectory(testName)
            return CompileTo(source, Path.Combine(directory, "test.dll"))
        }

        private func CompileTo(source string, outputPath string)(ExitCode int32, Diagnostics string) {
            let sourcePath = Path.Combine(Path.GetDirectoryName(outputPath)!!, "test.gs")
            File.WriteAllText(sourcePath, source)
            let args[]string = []string{"/out:" + outputPath, "/target:library", "/targetframework:net10.0", sourcePath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                exitCode = Program.Main(args)
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            return (exitCode, compileOut.ToString() + compileErr.ToString())
        }

        private func AttributeTypeName(metadata MetadataReader, attribute CustomAttribute) string {
            switch attribute.Constructor.Kind {
                case HandleKind.MemberReference {
                    let member = metadata.GetMemberReference(MemberReferenceHandle(attribute.Constructor))
                    return if member.Parent.Kind == HandleKind.TypeReference {
                        metadata.GetString(metadata.GetTypeReference(TypeReferenceHandle(member.Parent)).Name)
                    } else {
                        string.Empty
                    }
                }
                case HandleKind.MethodDefinition {
                    let method = metadata.GetMethodDefinition(MethodDefinitionHandle(attribute.Constructor))
                    return metadata.GetString(metadata.GetTypeDefinition(method.GetDeclaringType()).Name)
                }
                default {
                    return string.Empty
                }
            }
        }

        private func CreateArtifactDirectory(testName string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "issue3873-artifacts",
                testName,
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }
    }
}
