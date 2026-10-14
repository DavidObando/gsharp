// <copyright file="NativeSliceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import Xunit

class NativeSliceTranslationTests {
    @Theory
    @InlineData("int slice = 5;", "native[0] + slice + array.Length", int32(14))
    @InlineData("int slice(int value) => value + 5;", "slice(native[0]) + array.Length", int32(14))
    func ValueAndFunctionCollisionsQualifyNativeStaticReferences(
        declaration string,
        resultExpression string,
        expected int32
    ) {
        let source = (`using Gsharp.Values;
namespace NativeValueCollisions;
public class Probe {
    public static int Run() {
        ` + "$declaration" + `
        int[] array = { 7, 8 };
        var native = Slice<int>.FromArray(array);
        return ` + "$resultExpression" + `;
    }
}`)
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.Slice[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Collision.cs", source)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Gsharp.Values.Slice[int32].FromArray(array)", printed)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Probe.Run()",
            []string{typeof(Gsharp.Values.Slice[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func PrinterSeparatesNativePermissionsArrayIdentityAndNullability() {
        let element = NamedTypeReference("string"){IsNullable = true}
        Assert.Equal(
            "readonly slice[string?]?",
            GSharpPrinter.RenderTypeReference(NativeSliceTypeReference(element, true){IsNullable = true})
        )
        Assert.Equal("slice[string?]", GSharpPrinter.RenderTypeReference(NativeSliceTypeReference(element)))
        Assert.Equal("[]?string?", GSharpPrinter.RenderTypeReference(ArrayTypeReference(element){IsNullable = true}))
    }

    @Fact
    func ShadowedNativeAliasesUseQualifiedRuntimeTypes() {
        const source = `using Gsharp.Values;
namespace ShadowTranslation;
public class slice<T> { }
public class Buffers {
    public Slice<int> Native;
    public ReadOnlySlice<int> View;
    public slice<int> Ordinary = new slice<int>();
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.Slice[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Shadow.cs", source)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("Native Gsharp.Values.Slice[int32]", printed)
        Assert.Contains("View Gsharp.Values.ReadOnlySlice[int32]", printed)
        Assert.Contains("Ordinary slice[int32]", printed)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
    }

    @Fact
    func MapperRecognizesRuntimeIdentityWithoutRewritingCSharpArrays() {
        const source = `#nullable enable
using Gsharp.Values;
namespace NativeTranslation;
public class Buffers {
    public Slice<int> Mutable;
    public ReadOnlySlice<string?>? ReadOnly;
    public int[]? Array;
    public int[] Tail(int[] value) => value[1..];
    public Slice<int> View(Slice<int> value) => value.Subslice(1, value.Length);
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.Slice[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Buffers.cs", source)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Empty(context.Diagnostics)
        let text = GSharpPrinter.Print(unit)
        Assert.Contains("Mutable slice[int32]", text)
        Assert.Contains("ReadOnly readonly slice[string?]?", text)
        Assert.Contains("Array []?int32", text)
        Assert.Contains("value[1..]", text)
        Assert.Contains("value.Subslice(1, value.Length)", text)
        Assert.Empty(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(text).Diagnostics)
        Assert.True(TranslationTestValidation.AssertBinds(text)!!.Success)
    }

    @Fact
    func NullableNativeSliceCastUsesUnambiguousConversion() {
        const source = `using Gsharp.Values;
namespace NativeTranslation;
public class Probe {
    public static bool Run() {
        Slice<string> empty = default;
        return ((Slice<string>?)empty).HasValue;
    }
    public static Slice<string> RejectNullOwner() => Slice<string>.FromArray(null);
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.Slice[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("cast[slice[string]?](empty)", printed, StringComparison.Ordinal)
        Assert.Contains("slice[string].FromArray(default([]string))", printed, StringComparison.Ordinal)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
    }
}
