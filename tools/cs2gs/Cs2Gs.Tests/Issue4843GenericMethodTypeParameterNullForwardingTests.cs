// <copyright file="Issue4843GenericMethodTypeParameterNullForwardingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4843: a parameter promoted to <c>T?</c> because its caller passes
/// <c>null</c>, then forwarded to an imported generic METHOD whose parameter
/// is declared as a method type parameter
/// (<c>DecodeSignature&lt;TType, TGenericContext&gt;(provider, TGenericContext)</c>),
/// must not be bridged with a runtime <c>!!</c>: gsc infers that type argument
/// from the argument, and the assertion turned a legal C# call into a
/// NullReferenceException (migrated test/Core.Tests CorePublicApiSnapshotTests).
/// </summary>
public class Issue4843GenericMethodTypeParameterNullForwardingTests
{
    [Fact]
    public void Oblivious_NullForwardedToImportedMethodTypeParameter_IsNotAsserted()
    {
        string printed = TranslateOblivious(@"
using System.Reflection.Metadata;
namespace Demo
{
    public class P : ISignatureTypeProvider<string, object>
    {
        public string Describe(MetadataReader r, TypeSpecificationHandle h) => GetTypeFromSpecification(r, null, h, 0);
        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
            reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
        public string GetPrimitiveType(PrimitiveTypeCode t) => """";
        public string GetGenericTypeParameter(object c, int i) => """";
        public string GetGenericMethodParameter(object c, int i) => """";
        public string GetTypeFromDefinition(MetadataReader r, TypeDefinitionHandle h, byte k) => """";
        public string GetTypeFromReference(MetadataReader r, TypeReferenceHandle h, byte k) => """";
        public string GetGenericInstantiation(string g, System.Collections.Immutable.ImmutableArray<string> a) => """";
        public string GetArrayType(string e, ArrayShape s) => """";
        public string GetByReferenceType(string e) => """";
        public string GetPointerType(string e) => """";
        public string GetSZArrayType(string e) => """";
        public string GetFunctionPointerType(MethodSignature<string> s) => """";
        public string GetModifiedType(string m, string u, bool b) => """";
        public string GetPinnedType(string e) => """";
    }
}");

        string flat = System.Text.RegularExpressions.Regex.Replace(printed, @"\s+", " ");
        Assert.Contains("genericContext object?", flat, StringComparison.Ordinal);
        Assert.True(flat.Contains("DecodeSignature(this, genericContext)"), flat);
        Assert.DoesNotContain("genericContext!!", flat, StringComparison.Ordinal);
    }

    [Fact]
    public void Oblivious_NullForwardedToClassTypeParameterTarget_StillAsserted()
    {
        string printed = TranslateOblivious(@"
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
}");

        // Control: a CLASS type parameter is fixed by the receiver before the
        // argument is seen, so the existing bridge (or equivalent widening)
        // must be untouched by the method-type-parameter exemption.
        Assert.True(
            printed.Contains("items.Add(s!!)") || printed.Contains("List[string?]"),
            printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
