// <copyright file="Issue4584UnscopedRefReferenceAssemblyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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
/// Issue #4584: an SDK build binds against the reference assembly
/// (<c>System.Runtime</c>), whose <c>UnscopedRefAttribute</c> has a different
/// assembly name and key than the host runtime's (<c>System.Private.CoreLib</c>).
/// Recognition compared against the host identity only, so a genuine
/// <c>@UnscopedRef</c> was ignored and GS0589 fired on the annotated member
/// (migrated <c>test/Core.Tests</c> failed to compile). The expectation never
/// names the load context: the same source must bind for every closure.
/// </summary>
public class Issue4584UnscopedRefReferenceAssemblyTests
{
    private const string Annotated = """
        package P
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
        }
        """;

    private const string Unannotated = """
        package P

        ref struct S {
            private var value int32

            func Get() ref int32 {
                return ref this.value
            }
        }
        """;

    public static IEnumerable<object[]> Closures()
    {
        yield return new object[] { "host runtime" };
        foreach (var pack in TargetingPackDirectories())
        {
            yield return new object[] { pack };
        }
    }

    [Theory]
    [MemberData(nameof(Closures))]
    public void AnnotatedMembers_DoNotReportGS0589(string closure)
    {
        var diagnostics = EmitDiagnostics(closure, Annotated);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0589");
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Theory]
    [MemberData(nameof(Closures))]
    public void UnannotatedMember_StillReportsGS0589(string closure)
    {
        var diagnostics = EmitDiagnostics(closure, Unannotated);
        Assert.Contains(diagnostics, d => d.Id == "GS0589");
    }

    [Fact]
    public void SameNamedAttributeWithoutThePlatformKey_IsNotRecognized()
    {
        var assembly = System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(
            new System.Reflection.AssemblyName("System.Runtime"),
            System.Reflection.Emit.AssemblyBuilderAccess.Run);
        var type = assembly
            .DefineDynamicModule("m")
            .DefineType("System.Diagnostics.CodeAnalysis.UnscopedRefAttribute", System.Reflection.TypeAttributes.Public)
            .CreateType();

        Assert.False(GSharp.Core.CodeAnalysis.Binding.KnownAttributes.IsUnscopedRef(type));
        Assert.True(GSharp.Core.CodeAnalysis.Binding.KnownAttributes.IsUnscopedRef(
            typeof(System.Diagnostics.CodeAnalysis.UnscopedRefAttribute)));
    }

    [Fact]
    public void TargetingPack_IsAvailable()
    {
        Assert.True(
            TargetingPackDirectories().Any(),
            "no Microsoft.NETCore.App.Ref targeting pack was available; the reference-assembly closure is what discriminates this fix");
    }

    private static List<Diagnostic> EmitDiagnostics(string closure, string source)
    {
        using var resolver = closure == "host runtime"
            ? ReferenceResolver.Default()
            : ReferenceResolver.WithReferences(Directory.EnumerateFiles(closure, "*.dll"));
        var compilation = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)));
        using var stream = new MemoryStream();
        return compilation.Emit(stream).Diagnostics.ToList();
    }

    private static IEnumerable<string> TargetingPackDirectories()
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
        var dotnetRoot = Directory.GetParent(runtimeDirectory ?? string.Empty)?.Parent?.Parent?.FullName;
        if (dotnetRoot == null)
        {
            yield break;
        }

        var packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        if (!Directory.Exists(packsRoot))
        {
            yield break;
        }

        foreach (var version in Directory.EnumerateDirectories(packsRoot).OrderBy(d => d, StringComparer.Ordinal))
        {
            var refDirectory = Path.Combine(version, "ref", $"net{Environment.Version.Major}.0");
            if (Directory.Exists(refDirectory))
            {
                yield return refDirectory;
            }
        }
    }
}
