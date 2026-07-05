// <copyright file="Issue2126InlineOutVarMarkerLeakTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #2126: the overload-resolution sentinel type
/// <c>OverloadResolution+InlineOutVarArgumentMarker</c> must never escape the
/// binder into type projection or emit.
/// <para>
/// When an inline <c>out var</c> (or a pre-declared <c>out</c> whose pointee is a
/// same-compilation value type with no reference-context CLR type) is passed to a
/// generic method whose type parameter is inferable only from that <c>out</c>
/// slot — e.g. <c>Enum.TryParse&lt;TEnum&gt;(string, bool, out TEnum)</c> — the
/// sentinel marker was bound to <c>TEnum</c> during type inference and then
/// projected into the reference set's
/// <see cref="System.Reflection.MetadataLoadContext"/>. Projecting the
/// GSharp.Core-defined marker (which has no name in the reference set) threw
/// <c>InvalidOperationException</c>, surfaced as a fatal <c>GS9998</c> ICE.
/// </para>
/// <para>
/// The crash only reproduces on the <c>/reference:</c> resolver path (MLC), which
/// is why <c>Issue1601GenericEnumTryParseForwardTests</c> — running on the
/// host-runtime resolver — never caught it. The fix normalises the sentinel to
/// its erased <see cref="object"/> form before a generic candidate is closed.
/// </para>
/// </summary>
public class Issue2126InlineOutVarMarkerLeakTests
{
    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at the full shared-
    /// framework assembly set, forcing gsc into the
    /// <see cref="System.Reflection.MetadataLoadContext"/> resolution path —
    /// the same path the cs2gs migration pipeline and the MSBuild task drive
    /// gsc through via <c>/reference:</c>. The full closure is required to
    /// reproduce issue #2126: with only a handful of assemblies the leaking
    /// <c>Enum.TryParse</c> candidate is not projected through the load context.
    /// </summary>
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        var paths = Directory.GetFiles(runtimeDir, "*.dll");
        return ReferenceResolver.WithReferences(paths);
    }

    private static ImmutableArray<Diagnostic> EmitWithMlc(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(MetadataLoadContextResolver(), tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return result.Diagnostics;
    }

    /// <summary>
    /// The minimal reproduction: a generic <c>Enum.TryParse&lt;TEnum&gt;</c> whose
    /// only type-parameter binding site is a pre-declared <c>out</c> argument of a
    /// same-compilation enum. Pre-fix this threw the <c>GS9998</c> marker-projection
    /// ICE under the MLC resolver.
    /// </summary>
    [Fact]
    public void GenericEnumTryParse_PredeclaredUserEnumOut_UnderMlc_DoesNotLeakMarker()
    {
        var source = """
            package Repro
            import System

            enum ECodec { A, B }

            class ExCodec {
                shared {
                    func TryParseCodec(format string?, out codec ECodec) bool {
                        if format == nil {
                            codec = default(ECodec)
                            return false
                        }
                        return Enum.TryParse(format, true, &codec)
                    }
                }
            }
            """;

        var diagnostics = EmitWithMlc(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
        Assert.DoesNotContain(
            diagnostics,
            d => d.Severity == DiagnosticSeverity.Error);
    }

    /// <summary>
    /// The inline <c>out var</c> variant: the type parameter is inferable only
    /// from the inline <c>out var</c> slot, whose element type is a
    /// same-compilation enum. Must bind without leaking the marker.
    /// </summary>
    [Fact]
    public void GenericEnumTryParse_InlineOutVarUserEnum_UnderMlc_DoesNotLeakMarker()
    {
        var source = """
            package Repro
            import System

            enum EStatus { Off, On }

            class Reader {
                shared {
                    func Read(text string) string {
                        if Enum.TryParse[EStatus](text, out var status) {
                            return status.ToString()
                        }
                        return ""
                    }
                }
            }
            """;

        var diagnostics = EmitWithMlc(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
        Assert.DoesNotContain(
            diagnostics,
            d => d.Severity == DiagnosticSeverity.Error);
    }

    /// <summary>
    /// The originally-reported shape: an inline <c>out var</c> passed to
    /// <c>Dictionary&lt;TKey, TValue&gt;.TryGetValue</c> where the receiver is a
    /// qualified static field and the value type is a same-compilation enum. Must
    /// bind cleanly under the MLC resolver with no marker leak.
    /// </summary>
    [Fact]
    public void DictionaryTryGetValue_QualifiedStaticFieldReceiver_UserEnumValue_UnderMlc_DoesNotLeakMarker()
    {
        var source = """
            package Repro
            import System
            import System.Collections.Generic

            enum EPseudoAsinId { None, First }

            class BookDbContext {
                shared {
                    let PseudoAsinsValue Dictionary[Type, EPseudoAsinId] = Dictionary[Type, EPseudoAsinId]()

                    func Lookup(t Type) string {
                        let succ = BookDbContext.PseudoAsinsValue.TryGetValue(t, out var pseudoAsinId)
                        if succ {
                            return pseudoAsinId.ToString()
                        }
                        return ""
                    }
                }
            }
            """;

        var diagnostics = EmitWithMlc(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
    }
}
