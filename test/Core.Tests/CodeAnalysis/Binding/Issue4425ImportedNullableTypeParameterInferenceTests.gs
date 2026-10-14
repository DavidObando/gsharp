// <copyright file="Issue4425ImportedNullableTypeParameterInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis

/// Issue #4425: a nullable argument passed to an IMPORTED generic method whose
/// parameter is the method's own type parameter annotated `T?` must infer
/// `T` as the argument's underlying type, as C# does and as the same
/// method declared in G# source already did. gsc unified the argument against
/// the parameter's CLR type, which erases the annotation, so
/// `Required<T>(T? value) where T : class` called with a
/// `Type?` inferred `T := Type?` and returned `Type?`. That kept
/// the migrated `test/Core.Tests` red: its `ReaderAgreementHarness`
/// calls Core's `Invariant.Required(open.DeclaringType, …)`.
class Issue4425ImportedNullableTypeParameterInferenceTests {
    /// The #4425 shape: a `string?` argument to an imported
    /// class-constrained `T?` slot infers `T := string`, so the call
    /// is a `string`.
    @Fact
    func Imported_ClassConstrained_NullableSlot_InfersUnderlyingType() {
        AssertCompiles("func Run(maybe string?) string -> Inv.Required(maybe)")
    }

    /// The same call against the same method declared in G# source infers the
    /// same `T`: imported and source inference agree.
    @Fact
    func Source_ClassConstrained_NullableSlot_InfersUnderlyingType() {
        let result = CompileGSharp(`package Issue4425.Consumer

class Inv {
    shared {
        func Required[T class](value T?) T -> value ?? throw InvalidOperationException()
    }
}

func Run(maybe string?) string -> Inv.Required(maybe)`)
        Assert.True(result.Success, Describe(result))
    }

    /// A non-null argument is unaffected: `T := string`.
    @Fact
    func Imported_ClassConstrained_NonNullArgument_InfersItself() {
        AssertCompiles("func Run(value string) string -> Inv.Required(value)")
    }

    /// Precision on the reference side: the call infers exactly
    /// `T := string`, not something wider than the argument.
    @Fact
    func Imported_ClassConstrained_ResultIsNotObject() {
        AssertCompiles("func Run(maybe string?) int32 -> Inv.Required(maybe).Length")
    }

    /// Control for the rule's `Unchanged` cell on the reference side: a
    /// plain, unannotated `T` slot given a `string?` infers
    /// `T := string?`, so the result stays nullable and cannot be narrowed.
    /// Only an annotated `T?` slot strips the argument's `?`.
    @Fact
    func Imported_UnannotatedSlot_NullableReferenceArgument_StaysNullable() {
        AssertCompiles("func Run(maybe string?) string? -> Inv.Identity(maybe)")
        let narrowed = Compile("func Run(maybe string?) string -> Inv.Identity(maybe)")
        Assert.False(narrowed.Success, "T := string? must not be narrowed to string")
    }

    /// The same control with an optional parameter: `T value = default`
    /// declares an unannotated slot, even though the imported parameter reads
    /// as nullable because of its `null` default. Inference reads the
    /// declaration, so a `string?` argument still infers
    /// `T := string?`.
    @Fact
    func Imported_UnannotatedOptionalSlot_NullableReferenceArgument_StaysNullable() {
        AssertCompiles("func Run(maybe string?) string? -> Inv.IdentityDefault(maybe)")
        let narrowed = Compile("func Run(maybe string?) string -> Inv.IdentityDefault(maybe)")
        Assert.False(narrowed.Success, "T := string? must not be narrowed to string")
    }

    /// The value-type counterpart. An unconstrained `T?` is the bare slot
    /// `T` in metadata, never `Nullable<T>`, so an `int32?`
    /// argument is its own type argument (`T := int32?`, as in C#) and the
    /// call stays nullable.
    @Fact
    func Imported_Unconstrained_NullableValueArgument_StaysNullable() {
        AssertCompiles("func Run(maybe int32?) int32? -> Inv.Id(maybe)")
        let narrowed = Compile("func Run(maybe int32?) int32 -> Inv.Id(maybe)")
        Assert.False(narrowed.Success, "T := int32? must not be narrowed to int32")
    }

    /// A non-null value argument to the unconstrained slot infers
    /// `T := int32`. It does not become `Nullable<int32>`.
    @Fact
    func Imported_Unconstrained_ValueArgument_InfersItself() {
        AssertCompiles("func Run() int32 -> Inv.Id(5)")
    }

    /// A `struct`-constrained `T?` IS `Nullable<T>`, and an
    /// `int32?` argument infers `T := int32` through it, imported and
    /// source alike.
    @Fact
    func StructConstrained_NullableSlot_InfersUnderlyingType_ImportedAndSource() {
        AssertCompiles("func Run(maybe int32?) int32 -> Inv.Val(maybe)")
        let source = CompileGSharp(`package Issue4425.Consumer

class Inv {
    shared {
        func Val[T struct](value T?) T -> value ?? default
    }
}

func Run(maybe int32?) int32 -> Inv.Val(maybe)`)
        Assert.True(source.Success, Describe(source))
    }

    private data struct CompileResult(Success bool, Diagnostics[]string) : IEquatable[
        Issue4425ImportedNullableTypeParameterInferenceTests.CompileResult
    ] { }

    shared {
        private const LibrarySource string = `#nullable enable
namespace Issue4425.Library;

public static class Inv
{
    public static T Required<T>(T? value) where T : class
        => value ?? throw new System.InvalidOperationException();

    public static T Id<T>(T? value) => value!;

    public static T Identity<T>(T value) => value;

    public static T IdentityDefault<T>(T value = default) => value;

    public static T Val<T>(T? value) where T : struct => value ?? default;
}`

        private func AssertCompiles(body string) {
            let result = Compile(body)
            Assert.True(result.Success, Describe(result))
        }

        private func Compile(body string) Issue4425ImportedNullableTypeParameterInferenceTests.CompileResult {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4425ImportedNullableTypeParameterInferenceTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let libraryPath = EmitCSharpLibrary(directory, "Issue4425.Library", LibrarySource)
                return CompileGSharp(`package Issue4425.Consumer
import Issue4425.Library

` + body, libraryPath)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch (IOException) { }
            }
        }

        private func Describe(
            result Issue4425ImportedNullableTypeParameterInferenceTests.CompileResult
        ) string -> string.Join(Environment.NewLine, result.Diagnostics)

        private func CompileGSharp(
            source string,
            references ...string
        ) Issue4425ImportedNullableTypeParameterInferenceTests
            .CompileResult {
            using let resolver = if references.Length == 0 {
                ReferenceResolver.Default()
            } else {
                ReferenceResolver.WithReferences(references)
            }
            resolver.CurrentAssemblyName = "Issue4425.Consumer"
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = "Issue4425.Consumer"
            }
            using let output = MemoryStream()
            let emit = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue4425.Consumer")
            return Issue4425ImportedNullableTypeParameterInferenceTests.CompileResult(
                emit.Success,
                emit.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> (d.Id + ": " + d.Message)).ToArray()
            )
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
    }
}
