// <copyright file="Issue3679InternalsVisibleToMemberAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

/// Issue #3679: a friend assembly must reach the `internal` METHODS of a
/// referenced assembly, not just its internal fields and properties.
///
/// The .NET SDK turns every `<InternalsVisibleTo Include="X" />`
/// msbuild item into an `@(AssemblyAttribute)` item, which
/// `Gsharp.NET.Sdk`'s `WriteGsharpAssemblyInfoTask` renders as the
/// file-level annotation `@assembly: System.Runtime.CompilerServices.InternalsVisibleTo("X")`
/// and the emitter writes as a real `InternalsVisibleToAttribute` row. All
/// of that already worked; what did not was the consumer side. The CLR
/// instance-call candidate walk
/// (`MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces`) and the
/// imported static-class probe enumerated `BindingFlags.Public` only, so
/// an internal method of a friend assembly was never even a candidate and the
/// call dead-ended at GS0159 "Cannot find function" — while an internal
/// property or field on the same type resolved fine, because those probes
/// already widened to `NonPublic` under the same friendship test. That
/// asymmetry is why every migrated `*.Tests` app lost cross-assembly
/// internal access to the project under test.
class Issue3679InternalsVisibleToMemberAccessTests {
    @Fact
    func FriendAssembly_Calls_Internal_Instance_Method_Of_Imported_CSharp_Class() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3679.Library", CSharpLibrarySource)
            let result = CompileGSharp(`package Issue3679.Friend
import Issue3679.Library

func Run() int32 {
    let bag = Bag()
    return bag.BeginTransaction()
}`, "Issue3679.Friend", libraryPath)
            Assert.True(result.Success, Describe(result))
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    @Fact
    func FriendAssembly_Calls_Internal_Static_Method_Of_Imported_CSharp_Class() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3679.Library", CSharpLibrarySource)
            let result = CompileGSharp(`package Issue3679.Friend
import Issue3679.Library

func Run() int32 -> Bag.MapToReferenceClrType()`, "Issue3679.Friend", libraryPath)
            Assert.True(result.Success, Describe(result))
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    @Fact
    func NonFriendAssembly_Still_Cannot_Call_An_Internal_Method() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3679.Library", CSharpLibrarySource)
            let result = CompileGSharp(`package Issue3679.Stranger
import Issue3679.Library

func Run() int32 {
    let bag = Bag()
    return bag.BeginTransaction()
}`, "Issue3679.Stranger", libraryPath)
            Assert.False(result.Success)
            Assert.Contains(
                result.Diagnostics,
                (d Issue3679InternalsVisibleToMemberAccessTests.DiagnosticInfo) -> d.Id == "GS0159"
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    @Fact
    func FriendAssembly_Still_Cannot_Call_A_Private_Method() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3679.Library", CSharpLibrarySource)
            let result = CompileGSharp(`package Issue3679.Friend
import Issue3679.Library

func Run() int32 {
    let bag = Bag()
    return bag.Secret()
}`, "Issue3679.Friend", libraryPath)
            Assert.False(result.Success)
            Assert.Contains(
                result.Diagnostics,
                (d Issue3679InternalsVisibleToMemberAccessTests.DiagnosticInfo) -> d.Id == "GS0159"
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// The producer half of the SDK path: the friend declaration a
    /// `<InternalsVisibleTo>` item becomes is the FULLY QUALIFIED,
    /// suffix-less `System.Runtime.CompilerServices.InternalsVisibleTo`
    /// spelling `WriteGsharpAssemblyInfoTask` renders from
    /// `@(AssemblyAttribute)` — not the bare `InternalsVisibleTo` a
    /// hand-written G# source uses. Both must grant the same access.
    @Fact
    func SdkGeneratedQualifiedAnnotation_Grants_Internal_Method_Access() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitGSharpLibrary(directory, "Issue3679.GsLibrary", `package Issue3679.GsLibrary

@assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Issue3679.Friend")

public class DiagnosticBag {
  public func Report() int32 -> 1

  internal func BeginTransaction() int32 -> 42
}`)
            let result = CompileGSharp(`package Issue3679.Friend
import Issue3679.GsLibrary

func Run() int32 {
    let bag = DiagnosticBag()
    return bag.BeginTransaction()
}`, "Issue3679.Friend", libraryPath)
            Assert.True(result.Success, Describe(result))
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    private data struct CompileResult(
        Success bool,
        Diagnostics[]Issue3679InternalsVisibleToMemberAccessTests.DiagnosticInfo
    ) : IEquatable[Issue3679InternalsVisibleToMemberAccessTests.CompileResult] { }

    private data struct DiagnosticInfo(Id string, Message string?) : IEquatable[
        Issue3679InternalsVisibleToMemberAccessTests.DiagnosticInfo
    ] { }

    shared {
        private const CSharpLibrarySource string = `using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Issue3679.Friend")]

namespace Issue3679.Library;

public class Bag
{
    public int Report() => 1;

    internal int BeginTransaction() => 42;

    internal int Hidden => 3;

    internal static int MapToReferenceClrType() => 7;

    private int Secret() => 9;
}`

        private func Describe(result Issue3679InternalsVisibleToMemberAccessTests.CompileResult) string -> string.Join(
            Environment.NewLine,
            result.Diagnostics.Select(
                (d Issue3679InternalsVisibleToMemberAccessTests.DiagnosticInfo) -> d.Id + ": " + d.Message
            )
        )

        private func CompileGSharp(
            source string,
            assemblyName string,
            references ...string
        ) Issue3679InternalsVisibleToMemberAccessTests
            .CompileResult {
            using let resolver = if references.Length == 0 {
                ReferenceResolver.Default()
            } else {
                ReferenceResolver.WithReferences(references)
            }
            resolver.CurrentAssemblyName = assemblyName
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = assemblyName
            }
            using let output = MemoryStream()
            let emit = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            return Issue3679InternalsVisibleToMemberAccessTests.CompileResult(
                emit.Success,
                emit
                    .Diagnostics
                    .Select(
                    (
                        d GSharp.Core.CodeAnalysis.Diagnostic
                    ) -> Issue3679InternalsVisibleToMemberAccessTests.DiagnosticInfo(d.Id, d.Message)
                )
                    .ToArray()
            )
        }

        private func EmitGSharpLibrary(directory string, assemblyName string, source string) string {
            let path = Path.Combine(directory, assemblyName + ".dll")
            using let resolver = ReferenceResolver.Default()
            resolver.CurrentAssemblyName = assemblyName
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = assemblyName,
                IsLibrary = true
            }
            using let output = File.Create(path)
            let emit = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return path
        }

        private func EmitCSharpLibrary(directory string, assemblyName string, source string) string {
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, assemblyName + ".dll")
            using let output = File.Create(path)
            let emit = compilation.Emit(output)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return path
        }

        private func CreateOutputDirectory() string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3679InternalsVisibleToMemberAccessTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }

        private func DeleteOutputDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { }
        }
    }
}
