// <copyright file="Issue2394SourceTypeMemberAccessPrecedenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2394: imports are bound compilation-wide (not scoped per source
/// file/tree — see <c>Binder.cs</c>'s single shared <c>scope.TryImport</c>
/// loop over every syntax tree), so an <c>import Some.Namespace</c> in ONE
/// file makes that namespace's imported CLR types visible while binding EVERY
/// OTHER file in the same compilation. Several member-access/expression
/// receiver-resolution code paths checked <c>scope.TryLookupImportedClass</c>
/// (imported CLR type) BEFORE <c>scope.TryLookupTypeAlias</c> (same-
/// compilation source type: struct/enum/interface) — the opposite precedence
/// from <see cref="Binder.LookupType(GSharp.Core.CodeAnalysis.Syntax.NameExpressionSyntax, bool)"/>
/// (used for type-clause positions), which has always preferred the source
/// type. So a same-simple-name CLR type imported via some UNRELATED file
/// could incorrectly shadow a compilation's own type's static member access,
/// static field/property write, "color color" resolution, and static
/// event/field compound assignment.
///
/// This was discovered via the real Oahu.Core migration: <c>Crc32.gs</c>
/// (package <c>Oahu.Core.Cryptography</c>) does a self-qualified static
/// access <c>Crc32.Table</c>/<c>Crc32.Polynomial</c>, while an unrelated file
/// in the SAME compilation (package <c>Oahu.Core</c>) has
/// <c>import Oahu.Aux</c> — a namespace that (via a transitive reference)
/// contains an unrelated imported <c>Oahu.Aux.Crc32 : HashAlgorithm</c> CLR
/// type with no <c>Table</c>/<c>Polynomial</c> members, causing
/// <c>GS0158 Cannot find member</c>.
///
/// These tests use the always-available <c>System.IO.Path</c> CLR type as
/// the "unrelated imported collider" (no custom reference assembly needed),
/// paired with a same-simple-name SOURCE <c>Path</c> struct declared in a
/// SEPARATE file that itself never imports <c>System.IO</c> — reproducing
/// the exact compilation-wide leak shape.
/// </summary>
public class Issue2394SourceTypeMemberAccessPrecedenceTests
{
    [Fact]
    public void StaticFieldRead_SourceStructWins_OverImportLeakedFromUnrelatedFile()
    {
        // File A never mentions `Path`, but imports System.IO — leaking
        // System.IO.Path (a CLR type) into the whole compilation's scope.
        // File B declares its OWN `Path` struct with a static field that does
        // NOT exist on System.IO.Path, and reads it via a plain (non-color-
        // color) static member access. Before the fix, `Path.Kind` resolved
        // to System.IO.Path (checked first) and failed with
        // "cannot find member Kind"; after the fix, the source struct wins.
        const string fileA = """
            package P
            import System.IO

            class Noise {
            }
            """;

        const string fileB = """
            package P

            struct Path {
                shared {
                    var Kind string = "gs-path"
                }
            }

            class Consumer {
                func Get() string {
                    return Path.Kind
                }
            }
            """;

        Assert.Empty(Bind(fileA, fileB));
    }

    [Fact]
    public void StaticFieldWrite_SourceStructWins_OverImportLeakedFromUnrelatedFile()
    {
        // Same leak shape as above, but exercising the WRITE path
        // (BindFieldAssignmentExpression's "Stream B" vs. ADR-0053 static
        // struct-field ordering).
        const string fileA = """
            package P
            import System.IO

            class Noise {
            }
            """;

        const string fileB = """
            package P

            struct Path {
                shared {
                    var Kind string = ""
                }
            }

            class Consumer {
                func Set() {
                    Path.Kind = "changed"
                }
            }
            """;

        Assert.Empty(Bind(fileA, fileB));
    }

    [Fact]
    public void StaticInterfaceFieldRead_SourceInterfaceWins_OverImportLeakedFromUnrelatedFile()
    {
        // Same leak shape, but for a same-simple-name source INTERFACE
        // (ADR-0089 / issue #1030 static interface field) rather than struct.
        const string fileA = """
            package P
            import System.IO

            class Noise {
            }
            """;

        const string fileB = """
            package P

            interface Path {
                shared {
                    var Kind string
                }
            }

            class Consumer {
                func Get() string {
                    return Path.Kind
                }
            }
            """;

        Assert.Empty(Bind(fileA, fileB));
    }

    [Fact]
    public void ColorColor_SourceStructWins_OverImportLeakedFromUnrelatedFile()
    {
        // TryResolveColorColorType path: a field named `Path` shadows BOTH
        // the imported System.IO.Path (leaked from fileA) and this file's own
        // `Path` struct. `Kind` is a static field of the source struct but
        // not a member of System.IO.Path at all, so before the fix the
        // color-color resolution matched (and stalled on) the wrong,
        // import-leaked type and the access fell through to the (incorrect)
        // instance-field interpretation, which then failed to find `Kind` on
        // a plain string.
        const string fileA = """
            package P
            import System.IO

            class Noise {
            }
            """;

        const string fileB = """
            package P

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
            }
            """;

        Assert.Empty(Bind(fileA, fileB));
    }

    [Fact]
    public void StaticEventCompoundAssignment_SourceStructWins_OverImportLeakedFromUnrelatedFile()
    {
        // ExpressionBinder.Async's event-subscription/compound-assignment
        // receiver resolution: same leak shape, but for `Path.Tick +=
        // handler` (a static event subscription) on a source struct.
        const string fileA = """
            package P
            import System.IO

            class Noise {
            }
            """;

        const string fileB = """
            package P
            import System

            struct Path {
                shared {
                    event Tick Action
                }
            }

            func handler() { }

            func Subscribe() {
                Path.Tick += handler
            }
            """;

        Assert.Empty(Bind(fileA, fileB));
    }

    [Fact]
    public void StaticFieldCompoundAssignment_SourceStructWins_OverImportLeakedFromUnrelatedFile()
    {
        // Same leak shape, compound-assignment (`+=`) to a plain static
        // field rather than an event — also routed through
        // ExpressionBinder.Async's receiver resolution.
        const string fileA = """
            package P
            import System.IO

            class Noise {
            }
            """;

        const string fileB = """
            package P

            struct Path {
                shared {
                    var Count int32
                }
            }

            func Bump() {
                Path.Count += 1
            }
            """;

        Assert.Empty(Bind(fileA, fileB));
    }

    [Fact]
    public void NoCollision_ImportedClrType_StillResolvesNormally()
    {
        // Negative control: with no same-simple-name source type anywhere in
        // the compilation, a qualified CLR static member access must
        // continue to resolve against the imported type exactly as before
        // the fix (no regression to the ordinary imported-class path).
        const string source = """
            package P
            import System.IO

            func Combine(a string, b string) string {
                return Path.Combine(a, b)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void NoCollision_SamePackage_SourceStructAlone_StillResolves()
    {
        // Negative control: a source struct with no colliding imported type
        // anywhere in the compilation must keep resolving exactly as before.
        const string source = """
            package P

            struct Counter {
                shared {
                    var Value int32 = 7
                }
            }

            func Get() int32 {
                return Counter.Value
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void OahuCoreRegression_Crc32SelfQualifiedStaticAccess_CompilesDespiteUnrelatedImportedCrc32Elsewhere()
    {
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
        var libraryPath = EmitCSharpLibrary(
            nameof(this.OahuCoreRegression_Crc32SelfQualifiedStaticAccess_CompilesDespiteUnrelatedImportedCrc32Elsewhere),
            """
            using System.Security.Cryptography;

            namespace Oahu.Aux
            {
                public sealed class Crc32 : HashAlgorithm
                {
                    protected override void HashCore(byte[] array, int ibStart, int cbSize) { }

                    protected override byte[] HashFinal() => new byte[4];

                    public override void Initialize() { }
                }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        const string otherFileSource = """
            package Oahu.Core

            import Oahu.Aux

            class OtherFile {
                shared {
                    func Noop() void {
                    }
                }
            }
            """;

        const string crc32Source = """
            package Oahu.Core.Cryptography

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
            }
            """;

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(otherFileSource)),
            GsSyntaxTree.Parse(SourceText.From(crc32Source)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string EmitCSharpLibrary(string caseName, string source)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2394", caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "CSharpLib2394.dll");

        var syntaxTree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "CSharpLib2394",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(params string[] sources)
    {
        var trees = sources.Select(s => GsSyntaxTree.Parse(SourceText.From(s))).ToImmutableArray();
        foreach (var tree in trees)
        {
            if (tree.Diagnostics.Any())
            {
                return tree.Diagnostics;
            }
        }

        var globalScope = Binder.BindGlobalScope(previous: null, trees);
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
