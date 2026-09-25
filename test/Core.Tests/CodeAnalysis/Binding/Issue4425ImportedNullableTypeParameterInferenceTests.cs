// <copyright file="Issue4425ImportedNullableTypeParameterInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4425: a nullable argument passed to an IMPORTED generic method whose
/// parameter is the method's own type parameter annotated <c>T?</c> must infer
/// <c>T</c> as the argument's underlying type, as C# does and as the same
/// method declared in G# source already did. gsc unified the argument against
/// the parameter's CLR type, which erases the annotation, so
/// <c>Required&lt;T&gt;(T? value) where T : class</c> called with a
/// <c>Type?</c> inferred <c>T := Type?</c> and returned <c>Type?</c>. That kept
/// the migrated <c>test/Core.Tests</c> red: its <c>ReaderAgreementHarness</c>
/// calls Core's <c>Invariant.Required(open.DeclaringType, …)</c>.
/// </summary>
public sealed class Issue4425ImportedNullableTypeParameterInferenceTests
{
    private const string LibrarySource = """
        #nullable enable
        namespace Issue4425.Library;

        public static class Inv
        {
            public static T Required<T>(T? value) where T : class
                => value ?? throw new System.InvalidOperationException();

            public static T Id<T>(T? value) => value!;

            public static T Val<T>(T? value) where T : struct => value ?? default;
        }
        """;

    /// <summary>
    /// The #4425 shape: a <c>string?</c> argument to an imported
    /// class-constrained <c>T?</c> slot infers <c>T := string</c>, so the call
    /// is a <c>string</c>.
    /// </summary>
    [Fact]
    public void Imported_ClassConstrained_NullableSlot_InfersUnderlyingType()
    {
        AssertCompiles(
            """
            func Run(maybe string?) string -> Inv.Required(maybe)
            """);
    }

    /// <summary>
    /// The same call against the same method declared in G# source infers the
    /// same <c>T</c>: imported and source inference agree.
    /// </summary>
    [Fact]
    public void Source_ClassConstrained_NullableSlot_InfersUnderlyingType()
    {
        var result = CompileGSharp(
            """
            package Issue4425.Consumer

            class Inv {
                shared {
                    func Required[T class](value T?) T -> value ?? throw InvalidOperationException()
                }
            }

            func Run(maybe string?) string -> Inv.Required(maybe)
            """);

        Assert.True(result.Success, Describe(result));
    }

    /// <summary>
    /// A non-null argument is unaffected: <c>T := string</c>.
    /// </summary>
    [Fact]
    public void Imported_ClassConstrained_NonNullArgument_InfersItself()
    {
        AssertCompiles(
            """
            func Run(value string) string -> Inv.Required(value)
            """);
    }

    /// <summary>
    /// Precision on the reference side: the call infers exactly
    /// <c>T := string</c>, not something wider than the argument.
    /// </summary>
    [Fact]
    public void Imported_ClassConstrained_ResultIsNotObject()
    {
        AssertCompiles(
            """
            func Run(maybe string?) int32 -> Inv.Required(maybe).Length
            """);
    }

    /// <summary>
    /// The value-type counterpart. An unconstrained <c>T?</c> is the bare slot
    /// <c>T</c> in metadata, never <c>Nullable&lt;T&gt;</c>, so an <c>int32?</c>
    /// argument is its own type argument (<c>T := int32?</c>, as in C#) and the
    /// call stays nullable.
    /// </summary>
    [Fact]
    public void Imported_Unconstrained_NullableValueArgument_StaysNullable()
    {
        AssertCompiles(
            """
            func Run(maybe int32?) int32? -> Inv.Id(maybe)
            """);

        var narrowed = Compile(
            """
            func Run(maybe int32?) int32 -> Inv.Id(maybe)
            """);
        Assert.False(narrowed.Success, "T := int32? must not be narrowed to int32");
    }

    /// <summary>
    /// A non-null value argument to the unconstrained slot infers
    /// <c>T := int32</c>. It does not become <c>Nullable&lt;int32&gt;</c>.
    /// </summary>
    [Fact]
    public void Imported_Unconstrained_ValueArgument_InfersItself()
    {
        AssertCompiles(
            """
            func Run() int32 -> Inv.Id(5)
            """);
    }

    /// <summary>
    /// A <c>struct</c>-constrained <c>T?</c> IS <c>Nullable&lt;T&gt;</c>, and an
    /// <c>int32?</c> argument infers <c>T := int32</c> through it, imported and
    /// source alike.
    /// </summary>
    [Fact]
    public void StructConstrained_NullableSlot_InfersUnderlyingType_ImportedAndSource()
    {
        AssertCompiles(
            """
            func Run(maybe int32?) int32 -> Inv.Val(maybe)
            """);

        var source = CompileGSharp(
            """
            package Issue4425.Consumer

            class Inv {
                shared {
                    func Val[T struct](value T?) T -> value ?? default
                }
            }

            func Run(maybe int32?) int32 -> Inv.Val(maybe)
            """);
        Assert.True(source.Success, Describe(source));
    }

    private static void AssertCompiles(string body)
    {
        var result = Compile(body);
        Assert.True(result.Success, Describe(result));
    }

    private static CompileResult Compile(string body)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4425ImportedNullableTypeParameterInferenceTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, "Issue4425.Library", LibrarySource);
            return CompileGSharp(
                "package Issue4425.Consumer\nimport Issue4425.Library\n\n" + body,
                libraryPath);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static string Describe(CompileResult result)
        => string.Join(Environment.NewLine, result.Diagnostics);

    private static CompileResult CompileGSharp(string source, params string[] references)
    {
        using var resolver = references.Length == 0
            ? ReferenceResolver.Default()
            : ReferenceResolver.WithReferences(references);
        resolver.CurrentAssemblyName = "Issue4425.Consumer";
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
        {
            AssemblyName = "Issue4425.Consumer",
        };

        using var output = new MemoryStream();
        var emit = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue4425.Consumer");
        return new CompileResult(
            emit.Success,
            emit.Diagnostics.Select(d => d.Id + ": " + d.Message).ToArray());
    }

    private static string EmitCSharpLibrary(string directory, string assemblyName, string source)
    {
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(directory, assemblyName + ".dll");
        using var output = File.Create(path);
        var emit = compilation.Emit(output);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return path;
    }

    private readonly record struct CompileResult(bool Success, string[] Diagnostics);
}
