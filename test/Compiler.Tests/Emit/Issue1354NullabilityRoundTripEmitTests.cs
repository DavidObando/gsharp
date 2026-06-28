// <copyright file="Issue1354NullabilityRoundTripEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1354: gsc→gsc nullability round-trip. After flipping the import
/// default so unannotated/oblivious imported reference types are nullable, the
/// emitter MUST stamp complete nullability metadata on every emitted member
/// (a type-level <c>[NullableContextAttribute(1)]</c> plus per-field/property
/// <c>[NullableAttribute]</c> for any position that deviates from the non-null
/// default). These tests compile a G# library, then re-read its fields and
/// properties through the same <see cref="System.Reflection.MetadataLoadContext"/>
/// path that <see cref="ClrNullability"/> uses at bind time, and assert that:
/// <list type="bullet">
/// <item><description>a non-null reference field/property re-reads as non-null;</description></item>
/// <item><description>a <c>T?</c> reference field/property re-reads as nullable;</description></item>
/// <item><description>a <c>List[string?]</c> field re-reads with its inner element nullable.</description></item>
/// </list>
/// Without the emit-completeness change the absent attribute would be re-read as
/// nullable (per the new default) and a non-null field would silently flip.
/// </summary>
public class Issue1354NullabilityRoundTripEmitTests
{
    [Fact]
    public void NonNullReferenceField_RoundTripsAsNonNull()
    {
        WithCompiledHolder(holder =>
        {
            var field = holder.GetField("NonNullField")!;
            var sym = ClrNullability.GetFieldTypeSymbol(field);

            Assert.IsNotType<NullableTypeSymbol>(sym);
            Assert.Same(TypeSymbol.String, sym);
        });
    }

    [Fact]
    public void NullableReferenceField_RoundTripsAsNullable()
    {
        WithCompiledHolder(holder =>
        {
            var field = holder.GetField("MaybeField")!;
            var sym = ClrNullability.GetFieldTypeSymbol(field);

            var nullable = Assert.IsType<NullableTypeSymbol>(sym);
            Assert.Same(TypeSymbol.String, nullable.UnderlyingType);
        });
    }

    [Fact]
    public void ListOfNullableElementField_RoundTripsWithInnerNullable()
    {
        WithCompiledHolder(holder =>
        {
            var field = holder.GetField("ListField")!;
            var sym = ClrNullability.GetFieldTypeSymbol(field);

            // Outer List is non-null → NullabilityAnnotatedTypeSymbol (not Nullable).
            var annotated = Assert.IsType<NullabilityAnnotatedTypeSymbol>(sym);

            // Inner element string? must re-read as nullable.
            var elem = annotated.GetTypeArgumentSymbol(0);
            var nullableElem = Assert.IsType<NullableTypeSymbol>(elem);
            Assert.Same(TypeSymbol.String, nullableElem.UnderlyingType);
        });
    }

    [Fact]
    public void NonNullReferenceProperty_RoundTripsAsNonNull()
    {
        WithCompiledHolder(holder =>
        {
            var prop = holder.GetProperty("NonNullProp")!;
            var sym = ClrNullability.GetPropertyTypeSymbol(prop);

            Assert.IsNotType<NullableTypeSymbol>(sym);
            Assert.Same(TypeSymbol.String, sym);
        });
    }

    [Fact]
    public void NullableReferenceProperty_RoundTripsAsNullable()
    {
        WithCompiledHolder(holder =>
        {
            var prop = holder.GetProperty("MaybeProp")!;
            var sym = ClrNullability.GetPropertyTypeSymbol(prop);

            var nullable = Assert.IsType<NullableTypeSymbol>(sym);
            Assert.Same(TypeSymbol.String, nullable.UnderlyingType);
        });
    }

    private static void WithCompiledHolder(Action<Type> assert)
    {
        const string source = """
            package Probe
            import System.Collections.Generic

            class Holder {
                var NonNullField string
                var MaybeField string?
                var ListField List[string?]
                prop NonNullProp string { get; set }
                prop MaybeProp string? { get; set }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var resolver = new System.Reflection.PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { dllPath }));
            using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
            var asm = mlc.LoadFromAssemblyPath(dllPath);
            var holder = asm.GetType("Probe.Holder")
                ?? throw new InvalidOperationException("Probe.Holder not found in emitted assembly.");

            assert(holder);
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1354_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
            // Best-effort cleanup; ignore failures.
        }
    }
}
