// <copyright file="Issue4843GenericMethodTypeParameterNullForwardingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #4843: a parameter promoted to `T?` because its caller passes
/// `null`, then forwarded to an imported generic METHOD whose parameter
/// is declared as a method type parameter
/// (`DecodeSignature<TType, TGenericContext>(provider, TGenericContext)`),
/// must not be bridged with a runtime `!!`: gsc infers that type argument
/// from the argument, and the assertion turned a legal C# call into a
/// NullReferenceException (migrated test/Core.Tests CorePublicApiSnapshotTests).
open class Issue4843GenericMethodTypeParameterNullForwardingTests {
    @Fact
    func Oblivious_NullForwardedToImportedMethodTypeParameter_IsNotAsserted() {
        let printed = TranslateOblivious(`
using System.Reflection.Metadata;
namespace Demo
{
    public class P : ISignatureTypeProvider<string, object>
    {
        public string Describe(MetadataReader r, TypeSpecificationHandle h) => GetTypeFromSpecification(r, null, h, 0);
        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
            reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
        public string GetPrimitiveType(PrimitiveTypeCode t) => "";
        public string GetGenericTypeParameter(object c, int i) => "";
        public string GetGenericMethodParameter(object c, int i) => "";
        public string GetTypeFromDefinition(MetadataReader r, TypeDefinitionHandle h, byte k) => "";
        public string GetTypeFromReference(MetadataReader r, TypeReferenceHandle h, byte k) => "";
        public string GetGenericInstantiation(string g, System.Collections.Immutable.ImmutableArray<string> a) => "";
        public string GetArrayType(string e, ArrayShape s) => "";
        public string GetByReferenceType(string e) => "";
        public string GetPointerType(string e) => "";
        public string GetSZArrayType(string e) => "";
        public string GetFunctionPointerType(MethodSignature<string> s) => "";
        public string GetModifiedType(string m, string u, bool b) => "";
        public string GetPinnedType(string e) => "";
    }
}`)
        let flat = Regex.Replace(printed, "\\s+", " ")
        Assert.Contains("genericContext object?", flat, StringComparison.Ordinal)
        Assert.True(flat.Contains("DecodeSignature(this, genericContext)"), flat)
        Assert.DoesNotContain("genericContext!!", flat, StringComparison.Ordinal)
    }

    @Fact
    func Oblivious_NullForwardedToClassTypeParameterTarget_StillAsserted() {
        let printed = TranslateOblivious(`
using System;
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
        private readonly List<string> items = new List<string>();
        public void Run() => Add(null);
        public void Add(string s) => items.Add(s);
        public int Count => items.Count;
    }
}`)
        // Control: a CLASS type parameter is fixed by the receiver before the
        // argument is seen, so the existing bridge (or equivalent widening)
        // must be untouched by the method-type-parameter exemption.
        Assert.True(printed.Contains("items.Add(s!!)") || printed.Contains("List[string?]"), printed)
    }

    @Fact
    func Oblivious_NullForwardedToImportedMethodTypeParameter_KeepsBridgeOnlyWhenConstrained() {
        // `Accept<T>(T) where T : class` rejects a nullable inferred type
        // argument, so its bridge must stay; the unconstrained, result-free
        // `Free<T>(T)` is the exempt shape.
        let tree = CSharpSyntaxTree.ParseText(
            "namespace Lib { public static class Sink { public static void Accept<T>(T value) where T : class { } public static void Free<T>(T value) { } } }"
        )
        let compilation = CSharpCompilation.Create(
            "Issue4843.Lib",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        using let stream = MemoryStream()
        let emitted = compilation.Emit(stream)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let reference = MetadataReference.CreateFromImage(stream.ToArray())
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
using Lib;
namespace Demo
{
    public class C
    {
        public void Run() => Both(null);
        public void Both(string s) { Sink.Accept(s); Sink.Free(s); }
    }
}`)}, CSharpProjectLoader.RuntimeReferences().Append(reference).ToList())
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("Sink.Accept(s!!)", printed, StringComparison.Ordinal)
        Assert.Contains("Sink.Free(s)", printed, StringComparison.Ordinal)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
