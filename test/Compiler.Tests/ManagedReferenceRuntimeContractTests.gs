// <copyright file="ManagedReferenceRuntimeContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis

class ManagedReferenceRuntimeContractTests {
    @Theory
    @MemberData("IncompatibleContracts")
    func IncompatibleRuntimeReportsGs0604BeforeEmission(mutation string, runtimeReflection bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtime = CompileRuntime(fixture.Directory, mutation)
        using let references = Resolve(runtime, runtimeReflection)
        const source = "package BadManagedRuntime\nfunc Capture(values []int32) managed[int32] { return managed(values[0]) }"
        let compilation = GSharpCompilation(references, GSharpSyntaxTree.Parse(source)){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output)
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0604"
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS9998"
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func QualifiedHandleCannotBypassIncompatibleRuntimeValidation(runtimeReflection bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtime = CompileRuntime(fixture.Directory, "borrow")
        using let references = Resolve(runtime, runtimeReflection)
        const source = `package QualifiedBadManagedRuntime
func Read(p Gsharp.Values.ManagedRef[int32]) int32 { return *p }
func Write(p Gsharp.Values.ManagedRef[int32]) { *p = 1 }
func Add(p Gsharp.Values.ManagedRef[int32]) { *p += 1 }
func Same(p Gsharp.Values.ManagedRef[int32], q Gsharp.Values.ManagedRef[int32]) bool { return p == q }`
        let compilation = GSharpCompilation(references, GSharpSyntaxTree.Parse(source)){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output)
        Assert.False(result.Success)
        Assert.True(
            result.Diagnostics.Count((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0604") >= 4
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS9998"
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CompleteRuntimeWorksInBothReflectionContexts(runtimeReflection bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtime = CompileRuntime(fixture.Directory, string.Empty)
        using let references = Resolve(runtime, runtimeReflection)
        Assert.True(ManagedReferenceTypes.TryResolveDefinition(references, false, out var writable))
        Assert.True(ManagedReferenceTypes.TryResolveDefinition(references, true, out var readOnly))
        Assert.NotNull(writable)
        Assert.NotNull(readOnly)
        Assert.True(ManagedReferenceTypes.TryResolveDefinition(references, false, out var again))
        Assert.Same(writable, again)
        const source = `package CompleteManagedRuntime
func Capture(values []int32) managed[int32] { return managed(values[0]) }
func View(p managed[int32]) readonly managed[int32] { return p.AsReadOnly() }`
        let compilation = GSharpCompilation(references, GSharpSyntaxTree.Parse(source)){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func RuntimeSourceSnapshots_MatchTheLiveRuntimeSources() {
        // Issue #4350: the mutation fixtures below read the runtime's C# source.
        // Gsharp.Runtime.Values now self-migrates to G#, so the migrated
        // repository has no C# runtime sources; the tests fall back to these
        // verbatim snapshots. Whenever the live C# sources exist, the snapshots
        // must match them exactly so the fixtures never drift.
        let liveRoot = LiveRuntimeSourceRoot()
        for file in RuntimeSourceFiles {
            let snapshot = File.ReadAllText(Path.Combine(SnapshotRuntimeSourceRoot(), file + ".txt"))
            let live = Path.Combine(liveRoot, file)
            if File.Exists(live) {
                Assert.Equal(File.ReadAllText(live), snapshot)
            } else {
                Assert.Contains("namespace Gsharp.Values;", snapshot, StringComparison.Ordinal)
            }
        }
    }

    shared {
        func IncompatibleContracts() sequence[[]object] {
            for mutation in[]string{
                "borrow",
                "readonly-permission",
                "writable-permission",
                "location",
                "factory",
                "view",
                "key-type",
                "key-object",
                "key-field",
                "key-field-signature",
                "factory-overload",
                "equality",
                "constraint",
                "constructor",
                "same-location",
                "slice-capture",
                "native-factory"
            } {
                yield[]object{mutation, false}
                yield[]object{mutation, true}
            }
        }

        private func Resolve(runtime string, runtimeReflection bool) ReferenceResolver {
            let references = if runtimeReflection {
                ReferenceResolver.WithRuntimeReferences([]string{runtime})
            } else {
                ReferenceResolver.WithReferences(ReferencePaths().Append(runtime))
            }
            Assert.True(references.TryResolveType("Gsharp.Values.ManagedRef`1", out var type))
            Assert.True(ReferenceResolver.TryGetAssemblyPath(type.Assembly, out var path))
            Assert.Equal(runtime, path)
            return references
        }

        private func ReferencePaths() IEnumerable[string] -> ReferenceResolver.HostTrustedPlatformAssemblyPaths().Where(
            (path string) -> Path.GetFileNameWithoutExtension(path) != "Gsharp.Runtime.Values"
        )

        private let RuntimeSourceFiles[]string = []string{
            "ManagedLocationKey.cs",
            "ManagedLocation.cs",
            "ManagedRef.cs",
            "ReadOnlyManagedRef.cs",
            "Slice.cs",
            "ReadOnlySlice.cs"
        }

        // Review finding (#4350): resolve both roots from the repository root
        // rather than a fixed number of `..` hops from the test output directory.
        private func LiveRuntimeSourceRoot() string -> Path.Combine(
            IlVerifier.FindRepoRoot(),
            "src",
            "Sdk",
            "Gsharp.Runtime.Values"
        )

        private func SnapshotRuntimeSourceRoot() string -> Path.Combine(
            IlVerifier.FindRepoRoot(),
            "test",
            "Compiler.Tests",
            "TestData",
            "RuntimeValuesSource"
        )

        private func ReadRuntimeSource(file string) string {
            let live = Path.Combine(LiveRuntimeSourceRoot(), file)
            return if File.Exists(live) {
                File.ReadAllText(live)
            } else {
                File.ReadAllText(Path.Combine(SnapshotRuntimeSourceRoot(), file + ".txt"))
            }
        }

        private func CompileRuntime(directory string, mutation string) string {
            let version Version? = typeof(Gsharp.Values.ManagedRef[_]).Assembly.GetName().Version
            let sources = List[Microsoft.CodeAnalysis.SyntaxTree]{CSharpSyntaxTree.ParseText((`global using System;
global using System.Collections.Generic;
[assembly: System.Reflection.AssemblyVersion("` + "$version" + `")]`))}
            for file in RuntimeSourceFiles {
                var text = ReadRuntimeSource(file)
                text = switch mutation {
                    case "borrow": text.Replace("Borrow", "MissingBorrow", StringComparison.Ordinal)
                    case "readonly-permission": text.Replace(
                        "ref readonly T Borrow()",
                        "ref T Borrow()",
                        StringComparison.Ordinal
                    )
                    case "writable-permission": text.Replace(
                        "ref T Borrow()",
                        "ref readonly T Borrow()",
                        StringComparison.Ordinal
                    )
                    case "location": text.Replace("GetLocation", "MissingLocation", StringComparison.Ordinal)
                    case "same-location": text.Replace("SameLocation", "MissingSameLocation", StringComparison.Ordinal)
                    case "slice-capture": text.Replace(
                        "GetManagedReference",
                        "MissingManagedReference",
                        StringComparison.Ordinal
                    )
                    case "factory": text.Replace("FromArray", "MissingFactory", StringComparison.Ordinal)
                    case "native-factory": text.Replace(
                        "FromArrayNative",
                        "MissingNativeFactory",
                        StringComparison.Ordinal
                    )
                    case "view": text.Replace("AsReadOnly", "MissingView", StringComparison.Ordinal)
                    case "key-type": text.Replace("ManagedLocationKey", "MissingLocationKey", StringComparison.Ordinal)
                    case "key-object": text.Replace(
                        "ManagedLocationKey Object(",
                        "ManagedLocationKey MissingObject(",
                        StringComparison.Ordinal
                    )
                    case "key-field": text.Replace(
                        "ManagedLocationKey Field(",
                        "ManagedLocationKey MissingField(",
                        StringComparison.Ordinal
                    )
                    case "key-field-signature": text.Replace(
                        "RuntimeTypeHandle declaringType",
                        "Type declaringType",
                        StringComparison.Ordinal
                    )
                        .Replace(
                        "(field, declaringType)",
                        "(field, declaringType.TypeHandle)",
                        StringComparison.Ordinal
                    )
                    case "factory-overload" when file == "ManagedRef.cs": text.Replace(
                        "public abstract ref T Borrow();",
                        "public abstract ref T Borrow();\npublic static ManagedRef<T> FromArray(T[] owner) => FromArray(owner, 0);",
                        StringComparison.Ordinal
                    )
                    case "equality": text.Replace("operator ==", "MissingEquality", StringComparison.Ordinal).Replace(
                        "operator !=",
                        "MissingInequality",
                        StringComparison.Ordinal
                    )
                    case "constraint": text
                        .Replace(
                        "ManagedLocation<T>\n{",
                        "ManagedLocation<T> where T : class\n{",
                        StringComparison.Ordinal
                    )
                        .Replace(
                        ": ManagedLocation<T>\n{",
                        ": ManagedLocation<T> where T : class\n{",
                        StringComparison.Ordinal
                    )
                        .Replace("IEnumerable<T>\n{", "IEnumerable<T> where T : class\n{", StringComparison.Ordinal)
                    case "constructor" when file == "ManagedRef.cs": text.Replace(
                        "public abstract ref T Borrow();",
                        "private ManagedRef() { }\npublic abstract ref T Borrow();",
                        StringComparison.Ordinal
                    )
                    default: text
                }
                if mutation == "equality" {
                    text = text.Replace("!(left == right)", "!MissingEquality(left, right)", StringComparison.Ordinal)
                }
                sources.Add(CSharpSyntaxTree.ParseText(text))
            }
            let compilation = CSharpCompilation.Create(
                "Gsharp.Runtime.Values",
                sources,
                ReferencePaths().Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let path = Path.Combine(directory, "Gsharp.Runtime.Values.dll")
            let emitted = compilation.Emit(path)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            return path
        }
    }
}
