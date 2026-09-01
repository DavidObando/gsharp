// <copyright file="Issue3752MethodGroupLoadContextDifferentialTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3752 (issue #3705, family 3; #3684's "F13") — a method-group
/// conversion at a native function type whose signature mentions a type
/// projected from the compilation's <see cref="System.Reflection.MetadataLoadContext"/>.
/// <para>
/// <c>FunctionTypeSymbol.BuildClrType</c> gives <c>(Type) -&gt; Type</c> its
/// CLR shape by closing the <em>live</em> <c>System.Func`2</c> over the
/// parameter and return symbols' <c>ClrType</c>s. Under any <c>/reference:</c>
/// compile those are MLC types, and
/// <c>typeof(Func&lt;,&gt;).MakeGenericType(mlcType, mlcType)</c> cannot yield
/// a <c>RuntimeType</c> — the runtime materialises a
/// <c>System.Reflection.Emit.TypeBuilderInstantiation</c> instead, whose
/// <c>GetMethod("Invoke")</c> throws <see cref="NotSupportedException"/>.
/// <c>ConversionClassifier.BindClrMethodGroupConversion</c> reflected
/// <c>Invoke</c> directly, so it saw "no invoke method" and reported GS0218
/// for <em>every</em> method group at a function type over an imported type,
/// while the identical conversion over host runtime types
/// (<c>(string) -&gt; bool</c>) succeeded.
/// </para>
/// <para>
/// Shaped like <c>Issue3705LoadContextDifferentialTests</c>: the reflection
/// context never appears on the right-hand side of an expectation. Each row
/// states one answer and it is asserted for both the default (host runtime)
/// resolver and the MetadataLoadContext resolver. The rows expecting
/// <c>GS0218</c> are the anti-vacuity half — they prove the fixture can still
/// observe the diagnostic it is asserting the absence of elsewhere.
/// </para>
/// </summary>
public class Issue3752MethodGroupLoadContextDifferentialTests
{
    /// <summary>
    /// The differential table: <c>(label, G# source, the one expected
    /// diagnostic set)</c>, with the reflection context deliberately absent
    /// from the expectation.
    /// </summary>
    /// <returns>The xUnit member-data rows.</returns>
    public static TheoryData<string, string, string> Rows()
    {
        var data = new TheoryData<string, string, string>();

        void Add(string label, string body, string expected)
            => data.Add(label, body, expected);

        // --- Signatures over `System.Type`, which every MLC projects. These
        // are the defect: all of them reported GS0218 under the MLC resolver
        // and bound cleanly under the host one.
        Add(
            "static-projected-both-positions",
            """
            func probe() {
                let g (Type) -> Type = Nullable.GetUnderlyingType
            }
            """,
            "<none>");

        Add(
            "static-projected-nullable-spelling",
            """
            func probe() {
                let g (Type?) -> Type? = Nullable.GetUnderlyingType
            }
            """,
            "<none>");

        Add(
            "static-projected-optional-function-type",
            """
            func probe() {
                let g ((Type?) -> Type?)? = Nullable.GetUnderlyingType
            }
            """,
            "<none>");

        // Return position alone is enough: `Func<Type>` is just as unreachable
        // a closure as `Func<Type, Type>`.
        Add(
            "instance-projected-return-only",
            """
            func probe(t Type) {
                let g () -> Type = t.MakeArrayType
            }
            """,
            "<none>");

        // Parameter position alone, with a primitive return.
        Add(
            "instance-projected-parameter-only",
            """
            func probe(t Type) {
                let g (Type) -> bool = t.IsAssignableFrom
            }
            """,
            "<none>");

        // --- The control that always worked: no projected type in the
        // signature, so `BuildClrType` closes `Func<string, bool>` over host
        // runtime types and produces a real `RuntimeType`.
        Add(
            "control-no-projected-type",
            """
            func probe(t string) {
                let g (string) -> bool = t.StartsWith
            }
            """,
            "<none>");

        // --- Anti-vacuity: genuinely inapplicable method groups must STILL be
        // rejected, in both contexts. Without these the rows above could be
        // satisfied by a binder that stopped diagnosing anything.
        Add(
            "reject-arity-mismatch",
            """
            func probe() {
                let g (Type, Type) -> Type = Nullable.GetUnderlyingType
            }
            """,
            "GS0218");

        Add(
            "reject-return-mismatch",
            """
            func probe() {
                let g (Type) -> string = Nullable.GetUnderlyingType
            }
            """,
            "GS0218");

        Add(
            "reject-parameter-mismatch",
            """
            func probe() {
                let g (string) -> Type = Nullable.GetUnderlyingType
            }
            """,
            "GS0218");

        return data;
    }

    /// <summary>
    /// The invariant: whether a method group converts to a function type is a
    /// property of the signature, not of the reflection context the
    /// signature's types were materialised in.
    /// </summary>
    /// <param name="label">The row label (diagnostic aid only).</param>
    /// <param name="body">The G# declaration under test.</param>
    /// <param name="expected">The single expected answer, for both contexts.</param>
    [Theory]
    [MemberData(nameof(Rows))]
    public void SameAnswer_ForRuntimeResolver_AndMetadataLoadContextResolver(string label, string body, string expected)
    {
        var source = "package P\nimport System\n\n" + body;

        var hostAnswer = Compile(source, mlc: false);
        var mlcAnswer = Compile(source, mlc: true);

        Assert.True(expected == hostAnswer, $"[{label}] host resolver: expected '{expected}', got '{hostAnswer}'");
        Assert.True(expected == mlcAnswer, $"[{label}] MetadataLoadContext resolver: expected '{expected}', got '{mlcAnswer}'");
    }

    /// <summary>
    /// The hazard this family exists for, pinned directly: a native function
    /// type over an MLC-projected type is not a <c>RuntimeType</c> at all, and
    /// reflecting <c>Invoke</c> off it throws rather than answering. This is
    /// why the site had to read its signature through
    /// <see cref="ClrLoadContext.TryGetDelegateSignature"/>, and it doubles as
    /// proof that this fixture's MLC really is a distinct reflection context.
    /// </summary>
    [Fact]
    public void FunctionTypeOverProjectedType_HasNoReachableInvoke()
    {
        using var resolver = MetadataLoadContextResolver();
        var mlcType = resolver.MapClrTypeToReferences(typeof(Type));
        Assert.NotNull(mlcType);
        Assert.False(
            ReferenceEquals(typeof(Type), mlcType),
            "the fixture is not exercising two reflection contexts");

        // What `FunctionTypeSymbol.BuildClrType` produces for `(Type) -> Type`.
        var functionClr = typeof(Func<,>).MakeGenericType(mlcType!, mlcType!);
        Assert.False(functionClr.IsGenericTypeDefinition);
        Assert.Throws<NotSupportedException>(() => functionClr.GetMethod("Invoke"));

        // ... and what the funnel answers for the same type.
        Assert.True(ClrLoadContext.TryGetDelegateSignature(functionClr, out var parameters, out var returnType));
        Assert.Equal("System.Type", Assert.Single(parameters).FullName);
        Assert.Equal("System.Type", returnType.FullName);

        // The host-context twin, for contrast: an ordinary RuntimeType.
        Assert.NotNull(typeof(Func<Type, Type>).GetMethod("Invoke"));
    }

    private static string Compile(string source, bool mlc)
    {
        var resolver = mlc ? MetadataLoadContextResolver() : null;
        try
        {
            var tree = SyntaxTree.Parse(SourceText.From(source));
            var globalScope = resolver != null
                ? Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver)
                : Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
            var program = Binder.BindProgram(globalScope, resolver);
            var ids = globalScope.Diagnostics
                .AddRange(program.Diagnostics)
                .Where(d => d.IsError)
                .Select(d => d.Id)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(id => id, StringComparer.Ordinal)
                .ToArray();
            return ids.Length == 0 ? "<none>" : string.Join(", ", ids);
        }
        finally
        {
            resolver?.Dispose();
        }
    }

    /// <summary>
    /// The reference-assembly-backed resolver <c>gsc</c> uses on every real
    /// <c>/reference:</c> compile.
    /// </summary>
    /// <returns>A MetadataLoadContext-backed resolver.</returns>
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var runtimeDir = RuntimeEnvironment.GetRuntimeDirectory();
        var refPaths = Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly);
        return ReferenceResolver.WithReferences(refPaths);
    }
}
