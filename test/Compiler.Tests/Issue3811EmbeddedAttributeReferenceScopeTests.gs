// <copyright file="Issue3811EmbeddedAttributeReferenceScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Issue #3811: `NullableAttribute`/`NullableContextAttribute` rows
/// must never be scoped to a third-party assembly that merely happens to carry
/// its own embedded copy.
///
/// These two attributes are <em>compiler-embeddable</em>: csc synthesizes a
/// private copy into the emitting assembly whenever the target framework does
/// not publish them, which is why practically every `netstandard2.0`
/// package assembly contains an `internal`
/// `System.Runtime.CompilerServices.NullableAttribute` of its own. gsc
/// resolved the name across its whole reference closure with
/// `requireExternalVisibility: false` and scoped its TypeRef at whichever
/// package declared it first — for `src/Sdk/Gsharp.NET.Sdk` that was
/// `Microsoft.Build.Framework`. The emitted assembly then referenced a
/// type that is neither public nor present in that package's other assets, and
/// the NEXT gsc compilation that read the assembly's nullability metadata threw
/// `TypeLoadException: Could not find type
/// 'System.Runtime.CompilerServices.NullableAttribute' in assembly ''`,
/// reported as the internal-compiler-error diagnostic `GS9998`.
///
/// That crash is the single error walling `test/Sdk.Tests` out of the
/// issue #3501 self-migration gate: the migrated `Gsharp.NET.Sdk`
/// (netstandard2.0) emitted the bad rows and the migrated `Sdk.Tests`
/// (net10.0) crashed reading them. It is the same family as #3755 — emitting a
/// reference to a type the consuming target does not have.
///
/// The test EXECUTES the final program: an assembly that merely "compiles" can
/// still carry an unresolvable metadata row, so the proof has to load it.
open class Issue3811EmbeddedAttributeReferenceScopeTests {
    /// A library compiled with the donor in its reference closure must be
    /// consumable — and runnable — by a compilation that does NOT have the
    /// donor. Before the fix the consumer compile died in the reference
    /// resolver (or, when a same-named assembly WAS present without the type,
    /// with the gate's `GS9998 TypeLoadException ... in assembly ''`).
    @Fact
    func LibraryBuiltWithADonorAssembly_IsConsumableWithoutIt() {
        let tempDir = Directory.CreateTempSubdirectory("gs_3811_").FullName
        try {
            let donorPath = Path.Combine(tempDir, "Donor.dll")
            CompileOrThrow(
                "donor",
                DonorSource,
                donorPath,
                tempDir,
                target: "library",
                extraReferences: System.Array.Empty[string]()
            )
            let libPath = Path.Combine(tempDir, "Lib.dll")
            // The donor is listed FIRST so it wins the resolver's first-writer
            // precedence — the position Microsoft.Build.Framework occupies for
            // the migrated SDK, whose netstandard2.0 closure has no core
            // library declaring the attribute at all.
            CompileOrThrow(
                "lib",
                LibrarySource,
                libPath,
                tempDir,
                target: "library",
                extraReferences: []string{donorPath}
            )
            AssertNoForeignEmbeddableAttributeReference(libPath)
            let appPath = Path.Combine(tempDir, "App.dll")
            CompileOrThrow("app", ConsumerSource, appPath, tempDir, target: "exe", extraReferences: []string{libPath})
            IlVerifier.Verify(appPath, additionalReferences: []string{libPath})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the consumer must run. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("hello", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// ANTI-VACUITY: the fix must not have silenced nullability emission
    /// wholesale. Compiled against the <b>targeting pack</b> — what every real
    /// SDK build uses, and where the core contract assembly
    /// (`System.Runtime`) genuinely declares the attributes — the rows are
    /// still emitted, scoped there.
    ///
    /// The targeting pack is used rather than the test host's
    /// `TRUSTED_PLATFORM_ASSEMBLIES` precisely because the TPA set is full
    /// of third-party `netstandard2.0` assemblies carrying their own
    /// embedded copies — i.e. it is the defective input, not the reference one.
    @Fact
    func AgainstTheTargetingPack_NullabilityRowsAreStillEmitted() {
        let referencePack string? = FindReferencePack()
        Assert.True(
            referencePack != nil,
            "could not locate a Microsoft.NETCore.App.Ref targeting pack; this assertion is the " +
                "anti-vacuity guard for #3811 and must not be skipped silently."
        )
        let tempDir = Directory.CreateTempSubdirectory("gs_3811_pos_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            CompileOrThrow(
                "lib",
                LibrarySource,
                libPath,
                tempDir,
                target: "library",
                extraReferences: System.Array.Empty[string](),
                referenceSet: Directory.GetFiles(referencePack!!, "*.dll")
            )
            let scopes = EmbeddableAttributeReferenceScopes(libPath)
            Assert.NotEmpty(scopes)
            Assert.All(scopes, ($scope string) -> Assert.Equal("System.Runtime", $scope))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        // A third-party assembly carrying its own copy of the embeddable
        // attributes, exactly as csc embeds one into a netstandard2.0 assembly.
        private const DonorSource string = `
package System.Runtime.CompilerServices

import System

internal class NullableAttribute : Attribute {
    init(b uint8) {}
}

internal class NullableContextAttribute : Attribute {
    init(b uint8) {}
}
`

        // A library with nullable-annotated surface, so the emitter is asked for
        // the attribute ctors at all.
        private const LibrarySource string = `
package Lib

class Holder {
    var name string?
    func Get(input string?) string? -> input
}
`

        private const ConsumerSource string = `
import System
import Lib

let h = Holder()
Console.WriteLine(h.Get("hello"))
`

        // <dotnet-root>/packs/Microsoft.NETCore.App.Ref/<version>/ref/<tfm>
        private func FindReferencePack() string? {
            var dotnetRoot string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            while dotnetRoot != nil && !Directory.Exists(Path.Combine(dotnetRoot, "packs")) {
                dotnetRoot = Path.GetDirectoryName(dotnetRoot)
            }
            if dotnetRoot == nil {
                return nil
            }
            let packRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            if !Directory.Exists(packRoot) {
                return nil
            }
            return Directory
                .GetDirectories(packRoot)
                .OrderByDescending((dir string) -> dir, StringComparer.Ordinal)
                .Select((dir string) -> Path.Combine(dir, "ref"))
                .Where(Directory.Exists)
                .SelectMany(
                func (refDir string) IEnumerable[string] {
                    return Directory.GetDirectories(refDir).OrderByDescending((d string) -> d, StringComparer.Ordinal)
                }
            )
                .FirstOrDefault((tfmDir string) -> File.Exists(Path.Combine(tfmDir, "System.Runtime.dll")))
        }

        private func AssertNoForeignEmbeddableAttributeReference(assemblyPath string) {
            let coreLibraryName string? = typeof(object).Assembly.GetName().Name
            let foreign = EmbeddableAttributeReferenceScopes(assemblyPath).Where(
                ($scope string) -> !string.Equals($scope, coreLibraryName, StringComparison.Ordinal)
            )
                .ToArray()
            Assert.True(
                foreign.Length == 0,
                "the emitted assembly scopes a compiler-embeddable attribute at a non-core assembly " +
                    "(${string.Join(", ", foreign)}) — the #3811 defect."
            )
        }

        // The declaring-assembly name of every NullableAttribute /
        // NullableContextAttribute TypeRef in the assembly.
        private func EmbeddableAttributeReferenceScopes(assemblyPath string) IReadOnlyList[string] {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let scopes = List[string]()
            for handle in reader.TypeReferences {
                let typeReference = reader.GetTypeReference(handle)
                let name = reader.GetString(typeReference.Name)
                if !((name == "NullableAttribute" || name == "NullableContextAttribute")) {
                    continue
                }
                if typeReference.ResolutionScope.Kind != HandleKind.AssemblyReference {
                    scopes.Add("<" + typeReference.ResolutionScope.Kind.ToString() + ">")
                    continue
                }
                let assemblyReference = reader.GetAssemblyReference(
                    AssemblyReferenceHandle(typeReference.ResolutionScope)
                )
                scopes.Add(reader.GetString(assemblyReference.Name))
            }
            return scopes
        }

        private func CompileOrThrow(
            name string,
            source string,
            outPath string,
            tempDir string,
            target string,
            extraReferences[]string,
            referenceSet IEnumerable[string]? = nil
        ) {
            let srcPath = Path.Combine(tempDir, name + ".gs")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0"}
            // Deliberately BEFORE the platform assemblies: the resolver keeps
            // first-writer precedence, and this reproduces the position the donor
            // occupies in the real reference closure.
            for reference in extraReferences {
                args.Add("/reference:" + reference)
            }
            for reference in referenceSet ?? TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(exit == 0, (`gsc failed compiling '` + "$name" + `' (a GS9997/GS9998 here is the #3811 defect):
`) + (`stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
