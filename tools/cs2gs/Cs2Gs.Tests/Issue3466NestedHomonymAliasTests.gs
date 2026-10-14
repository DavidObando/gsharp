// <copyright file="Issue3466NestedHomonymAliasTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Signatures
import System
import System.Collections.Generic
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue3466NestedHomonymAliasTests {
    @Fact
    func LateSignatureFixture_PreservesNullableValueAndObliviousPeers() {
        // The fixture types are pinned as a frozen C# snapshot (#4661), not read
        // from the Cs2Gs.Tests project, which is G# after the cut-over.
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                ("LateSignatureTypes.cs", FrozenCompilerSnapshots.Read("Issue3466LateSignatureTypes.cs.txt"))
            }
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let fixture INamedTypeSymbol? = project.Compilation.GetTypeByMetadataName("Signatures.TargetTypedDefaults")
        Assert.NotNull(fixture)
        let value = fixture!!.GetMembers("Value").OfType[IPropertySymbol]().Single()
        let values = fixture!!.GetMembers("Values").OfType[IPropertySymbol]().Single()
        let indexer = fixture!!.GetMembers().OfType[IPropertySymbol]().Single((p IPropertySymbol) -> p.IsIndexer)
        Assert.Equal(NullableAnnotation.Annotated, value.Type.NullableAnnotation)
        Assert.Equal(NullableAnnotation.None, values.Type.NullableAnnotation)
        Assert.Equal(NullableAnnotation.None, indexer.Type.NullableAnnotation)
    }

    @Fact
    func NestedDocInlineList_DoesNotAliasImportedGenericList() {
        let printed = Translate(`using System.Collections.Generic;

namespace Demo
{
    public abstract record DocInline
    {
        public sealed record List(string Value) : DocInline;
    }

    public static class Repro
    {
        public static int Count()
        {
            var values = new List<string>();
            values.Add("one");
            return values.Count;
        }
    }
}`)
        Assert.Contains("import System.Collections.Generic", printed, StringComparison.Ordinal)
        Assert.Contains("List[string]()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import GenericList =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__cs2gs_", printed, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("public sealed class List { }")
    @InlineData("public sealed class List<T> { }")
    func TopLevelListHomonym_UsesReadableAlias(sourceDeclaration string) {
        let printed = Translate((`using System.Collections.Generic;

namespace Demo
{
    ` + "$sourceDeclaration" + `

    public static class Repro
    {
        public static int Count()
        {
            var values = new System.Collections.Generic.List<string>();
            values.Add("one");
            return values.Count;
        }
    }
}`))
        Assert.Contains("import GenericList = System.Collections.Generic.List", printed, StringComparison.Ordinal)
        Assert.Contains("GenericList[string]()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__cs2gs_", printed, StringComparison.Ordinal)
    }

    @Fact
    func ParamsCollectionAndCollectionExpression_InsideNestedGenericListScope_UseAliasAndRun() {
        let printed = Translate(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class List<T>
        {
        }

        public static int Total(params global::System.Collections.Generic.List<int> values)
        {
            int total = 0;
            foreach (int value in values)
            {
                total += value;
            }

            return total;
        }

        public static int TotalInterface(
            params global::System.Collections.Generic.IEnumerable<int> values)
        {
            int total = 0;
            foreach (int value in values)
            {
                total += value;
            }

            return total;
        }

        public static int Read()
        {
            return Total(1, 2, 3) + Total([4, 5]) + TotalInterface(6, 7);
        }
    }
}`)
        Assert.Contains("import GenericList = System.Collections.Generic.List", printed, StringComparison.Ordinal)
        // ADR-0173: params collections stay variadic (`...GenericList[int32]`)
        // and source-declared callees are called in natural expanded form; the
        // collection-expression argument passes through as the alias-spelled
        // carrier literal.
        Assert.Contains("func Total(values ...GenericList[int32]) int32", printed, StringComparison.Ordinal)
        Assert.Contains("Total(1, 2, 3)", printed, StringComparison.Ordinal)
        Assert.Contains("Total(GenericList[int32]{ 4, 5 })", printed, StringComparison.Ordinal)
        Assert.Contains("TotalInterface(6, 7)", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "System.Console.WriteLine(Demo.Holder.Read())", "28")
    }

    @Fact
    func NonListMetadataHomonym_UsesGeneralReadableAliasPath() {
        let printed = Translate(`namespace Demo
{
    public sealed class StringBuilder
    {
    }

    public static class Repro
    {
        public static int Length()
        {
            var builder = new System.Text.StringBuilder("one");
            return builder.Length;
        }
    }
}`)
        Assert.Contains("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("TextStringBuilder(\"one\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__cs2gs_", printed, StringComparison.Ordinal)
    }

    @Fact
    func ReadableAlias_AvoidsEnclosingMethodThatShadowsTypeCall() {
        let printed = Translate(`namespace Demo
{
    public sealed class StringBuilder
    {
    }

    public static class Repro
    {
        private static int TextStringBuilder()
        {
            return 4;
        }

        public static int Length()
        {
            var builder = new System.Text.StringBuilder("one");
            return builder.Length + TextStringBuilder();
        }
    }
}`)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("TextStringBuilder_2(\"one\")", printed, StringComparison.Ordinal)
        Assert.Contains("func TextStringBuilder() int32", printed, StringComparison.Ordinal)
    }

    @Fact
    func ReadableAlias_AvoidsInvokedLocalValues() {
        let printed = Translate(`using System;

namespace Demo
{
    public sealed class StringBuilder
    {
    }

    public static class LocalFunctionCase
    {
        public static int Read()
        {
            int TextStringBuilder() => 1;
            var builder = new System.Text.StringBuilder("one");
            return builder.Length + TextStringBuilder();
        }
    }

    public static class LocalCase
    {
        public static int Read()
        {
            Func<int> TextStringBuilder = () => 2;
            var builder = new System.Text.StringBuilder("two");
            return builder.Length + TextStringBuilder();
        }
    }
}`)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Equal(2, CountOccurrences(printed, "TextStringBuilder_2(\""))
        Assert.True(
            CountOccurrences(printed, "TextStringBuilder()") >= 2,
            "Invoked source values keep their emitted name while the generated type alias moves."
        )
    }

    // Issue #3471: sibling static member references now print bare inside
    // their declaring aggregate, and a file-scope import alias would shadow
    // them, so the readable-alias allocator must step aside to a suffixed
    // alias whenever a source static member claims the readable name.
    @Fact
    func ReadableAlias_AvoidsBareSiblingMemberValues() {
        let printed = Translate(`using System;

namespace Demo
{
    public sealed class StringBuilder
    {
    }

    public static class FieldCase
    {
        private static Func<int> TextStringBuilder = () => 3;

        public static int Read()
        {
            var builder = new System.Text.StringBuilder("three");
            return builder.Length + TextStringBuilder();
        }
    }

    public static class PropertyCase
    {
        private static Func<int> TextStringBuilder => () => 4;

        public static int Read()
        {
            var builder = new System.Text.StringBuilder("four");
            return builder.Length + TextStringBuilder();
        }
    }
}`)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Equal(2, CountOccurrences(printed, "TextStringBuilder_2(\""))
        Assert.DoesNotContain("FieldCase.TextStringBuilder()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("PropertyCase.TextStringBuilder()", printed, StringComparison.Ordinal)
        Assert.Contains("TextStringBuilder()", printed, StringComparison.Ordinal)
    }

    // Issue #3471: uninvoked sibling static value reads also print bare, so
    // the readable alias steps aside for them too; a same-named LOCAL alone
    // would not move the alias (locals stay lexically scoped), but the static
    // field/property cases in this snippet force the suffixed alias.
    @Fact
    func ReadableAlias_AvoidsUninvokedSiblingValueNames() {
        let printed = Translate(`namespace Demo
{
    public sealed class StringBuilder
    {
    }

    public static class FieldCase
    {
        private static int TextStringBuilder = 1;

        public static int Read()
        {
            var builder = new System.Text.StringBuilder("one");
            return builder.Length + TextStringBuilder;
        }
    }

    public static class PropertyCase
    {
        private static int TextStringBuilder => 2;

        public static int Read()
        {
            var builder = new System.Text.StringBuilder("two");
            return builder.Length + TextStringBuilder;
        }
    }

    public static class LocalCase
    {
        public static int Read()
        {
            int TextStringBuilder = 3;
            var builder = new System.Text.StringBuilder("three");
            return builder.Length + TextStringBuilder;
        }
    }
}`)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Equal(3, CountOccurrences(printed, "TextStringBuilder_2(\""))
    }

    @Fact
    func NestedSameArityMetadataType_DoesNotForceAlias() {
        let printed = Translate(`namespace Demo
{
    public sealed class Container
    {
        public sealed class StringBuilder
        {
        }
    }

    public static class Repro
    {
        public static int Length()
        {
            var builder = new System.Text.StringBuilder("one");
            return builder.Length;
        }
    }
}`)
        Assert.Contains("StringBuilder(\"one\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder =", printed, StringComparison.Ordinal)
    }

    @Fact
    func FullyQualifiedMetadataType_InsideNestedHomonymScope_UsesAlias() {
        let printed = Translate(`namespace Demo
{
    public sealed class Container
    {
        public sealed class StringBuilder
        {
        }

        public static int Length()
        {
            var builder = new System.Text.StringBuilder("one");
            return builder.Length;
        }
    }
}`)
        Assert.Contains("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("TextStringBuilder(\"one\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Container.StringBuilder(\"one\")", printed, StringComparison.Ordinal)
    }

    @Fact
    func NestedMetadataType_InsideOutermostNestedHomonymScope_UsesOuterAliasAndRuns() {
        let printed = Translate(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class Environment
        {
        }

        public static global::System.Environment.SpecialFolder Get()
        {
            return global::System.Environment.SpecialFolder.System;
        }

        public static int Read()
        {
            global::System.Environment.SpecialFolder value = Get();
            return value == global::System.Environment.SpecialFolder.System ? 7 : 0;
        }
    }
}`)
        Assert.Contains("import SystemEnvironment = System.Environment", printed, StringComparison.Ordinal)
        Assert.True(
            CountOccurrences(printed, "SystemEnvironment.SpecialFolder") >= 3,
            "Type and static-member positions must retain the metadata outer type identity."
        )
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "System.Console.WriteLine(Demo.Holder.Read())", "7")
    }

    @Fact
    func NestedMetadataType_WithGenericOutermostHomonym_UsesOuterAliasAndRuns() {
        let printed = Translate(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class Dictionary<TKey, TValue>
        {
        }

        public static global::System.Collections.Generic.Dictionary<int, int>.Enumerator Get(
            global::System.Collections.Generic.Dictionary<int, int> values)
        {
            return values.GetEnumerator();
        }

        public static int Read()
        {
            var values = new global::System.Collections.Generic.Dictionary<int, int>();
            values.Add(3, 4);
            var iterator = Get(values);
            return iterator.MoveNext()
                ? iterator.Current.Key + iterator.Current.Value
                : 0;
        }
    }
}`)
        Assert.Contains(
            "import GenericDictionary = System.Collections.Generic.Dictionary",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "func Get(values GenericDictionary[int32, int32]) GenericDictionary[int32, int32].Enumerator",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("GenericDictionary[int32, int32]()", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "System.Console.WriteLine(Demo.Holder.Read())", "7")
    }

    @Fact
    func NestedType_WithImportedTopLevelHomonym_RemainsQualified() {
        let printed = Translate(`using System.Text;

namespace Demo
{
    public sealed class Container
    {
        public sealed class StringBuilder
        {
            public int NestedOnly => 3;
        }

        public static int Read()
        {
            var builder = new StringBuilder();
            return builder.NestedOnly;
        }
    }
}`)
        Assert.Contains("Container.StringBuilder()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("TextStringBuilder()", printed, StringComparison.Ordinal)
    }

    @Fact
    func ReadableAlias_AvoidsExistingAliasAndSourceType() {
        let printed = Translate(`using GenericList = System.Text.StringBuilder;

namespace Demo
{
    public sealed class List
    {
    }

    public sealed class GenericList_2
    {
    }

    public static class Repro
    {
        public static int Count()
        {
            var first = new System.Collections.Generic.List<int>();
            var second = new System.Collections.Generic.List<int>();
            first.Add(1);
            second.Add(2);
            return first.Count + second.Count;
        }
    }
}`)
        Assert.Contains("import GenericList = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Equal(1, CountOccurrences(printed, "import GenericList_3 = System.Collections.Generic.List"))
        Assert.Equal(2, CountOccurrences(printed, "GenericList_3[int32]()"))
    }

    @Fact
    func ReadableAlias_AvoidsImportedBareTypeName() {
        let referencePath = typeof(TextStringBuilder).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(referencePath))
            .ToArray()
        using let resolver = ReferenceResolver.WithReferences([]string{referencePath})
        let printed = Translate(`using Cs2Gs.Tests;

namespace Demo
{
    public sealed class StringBuilder
    {
    }

    public static class Repro
    {
        public static System.Text.StringBuilder MakeBuilder()
        {
            return new System.Text.StringBuilder("one");
        }

        public static int Measure()
        {
            var builder = MakeBuilder();
            TextStringBuilder imported = new TextStringBuilder();
            return builder.Length + imported.Value;
        }
    }
}`, references, resolver)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("func MakeBuilder() TextStringBuilder_2 {", printed, StringComparison.Ordinal)
        Assert.Contains("return TextStringBuilder_2(\"one\")", printed, StringComparison.Ordinal)
    }

    @Fact
    func ReadableAlias_AvoidsTypeFromLateExtensionMethodGroupImport() {
        let referencePath = typeof(TextStringBuilder).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(referencePath))
            .ToArray()
        using let resolver = ReferenceResolver.WithReferences([]string{referencePath})
        let printed = Translate("Consumer.cs", [](string, string){("Consumer.cs", `namespace Demo
{
    public sealed class StringBuilder
    {
    }

    public static class Repro
    {
        public static System.Text.StringBuilder MakeBuilder()
        {
            return new System.Text.StringBuilder("one");
        }

        private static int Invoke(System.Func<int> action)
        {
            return action();
        }

        public static int Measure()
        {
            var builder = MakeBuilder();
            return builder.Length + Invoke("x".Issue3466Length);
        }
    }
}`), ("GlobalUsings.g.cs", "global using Cs2Gs.Tests;\n")}, references, resolver)
        Assert.Contains("import Cs2Gs.Tests", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.True(
            CountOccurrences(printed, "TextStringBuilder_2") >= 3,
            "Late import reservation should keep one exact alias in type and constructor positions."
        )
    }

    @Fact
    func ReadableAlias_AvoidsEmittedMethodTypeParameterName() {
        let printed = Translate(`namespace Demo
{
    public sealed class StringBuilder
    {
    }

    public static class Repro
    {
        public static System.Text.StringBuilder Make<TextStringBuilder>()
        {
            return new System.Text.StringBuilder("one");
        }
    }
}`)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("func Make[TextStringBuilder]() TextStringBuilder_2", printed, StringComparison.Ordinal)
        Assert.Contains("return TextStringBuilder_2(\"one\")", printed, StringComparison.Ordinal)
    }

    @Fact
    func ExistingAlias_IsNotReusedWhenMethodTypeParameterShadowsIt() {
        let printed = Translate(`using TextStringBuilder = System.Text.StringBuilder;

namespace Demo
{
    public sealed class StringBuilder
    {
    }

    public static class Repro
    {
        public static System.Text.StringBuilder Make<TextStringBuilder>()
        {
            return new System.Text.StringBuilder("one");
        }
    }
}`)
        Assert.Contains("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("func Make[TextStringBuilder]() TextStringBuilder_2", printed, StringComparison.Ordinal)
        Assert.Contains("return TextStringBuilder_2(\"one\")", printed, StringComparison.Ordinal)
    }

    @Fact
    func ExistingAlias_IsNotReusedWhenVisibleNestedSourceTypeShadowsIt() {
        let printed = Translate(`using StringBuilder = System.Text.StringBuilder;

namespace Demo
{
    public static class Before
    {
        public static int Length()
        {
            return new StringBuilder("before").Length;
        }
    }

    public sealed class Holder
    {
        public sealed class StringBuilder
        {
        }

        public static int Length()
        {
            return new System.Text.StringBuilder("nested").Length;
        }
    }

    public static class After
    {
        public static int Length()
        {
            return new StringBuilder("after").Length;
        }
    }
}`)
        Assert.Contains("import StringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Equal(1, CountOccurrences(printed, "import TextStringBuilder = System.Text.StringBuilder"))
        Assert.Equal(2, CountOccurrences(printed, "return StringBuilder(\""))
        Assert.Contains("TextStringBuilder(\"nested\")", printed, StringComparison.Ordinal)
    }

    @Fact
    func SameNamespaceTopLevelType_InsideNestedHomonymScope_StaysQualified() {
        let printed = Translate(`namespace Demo
{
    public sealed class Target
    {
    }

    public sealed class Holder
    {
        public sealed class Target
        {
        }

        public static global::Demo.Target MakeNestedScope()
        {
            return new global::Demo.Target();
        }
    }

    public static class Consumer
    {
        public static global::Demo.Target MakeSafe()
        {
            return new global::Demo.Target();
        }
    }
}`)
        Assert.Contains("func MakeNestedScope() Demo.Target", printed, StringComparison.Ordinal)
        Assert.Contains("return Demo.Target()", printed, StringComparison.Ordinal)
        Assert.Contains("func MakeSafe() Target", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func MakeSafe() Demo.Target", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import DemoTarget =", printed, StringComparison.Ordinal)
    }

    @Fact
    func GlobalSourceType_InsideNestedHomonymScope_UsesAliasAndRuns() {
        let printed = Translate(`public sealed class GlobalTarget
{
}

public sealed class Target
{
    public Target(int value)
    {
        Value = value;
    }

    public int Value { get; }

    public static int Shared() => 4;
}

public sealed class Holder
{
    public sealed class Target
    {
    }

    public static global::Target Make()
    {
        return new global::Target(3);
    }

    public static int Read()
    {
        global::Target value = new global::Target(5);
        return value.Value + global::Target.Shared();
    }
}`)
        Assert.Contains("import GlobalTarget_2 = Target", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import GlobalTarget = Target", printed, StringComparison.Ordinal)
        Assert.Contains("func Make() GlobalTarget_2", printed, StringComparison.Ordinal)
        Assert.Contains("return GlobalTarget_2(3)", printed, StringComparison.Ordinal)
        Assert.Contains("let value = GlobalTarget_2(5)", printed, StringComparison.Ordinal)
        Assert.Contains("GlobalTarget_2.Shared()", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "System.Console.WriteLine(Holder.Read())", "9")
    }

    @Fact
    func UnshadowedGlobalSourceType_RemainsBareAndRuns() {
        let printed = Translate(`public sealed class SafeTarget
{
    public SafeTarget(int value)
    {
        Value = value;
    }

    public int Value { get; }

    public static int Shared() => 2;
}

public sealed class Holder
{
    public sealed class Target
    {
    }

    public static global::SafeTarget Make()
    {
        return new global::SafeTarget(6);
    }

    public static int Read()
    {
        return Make().Value + global::SafeTarget.Shared();
    }
}`)
        Assert.DoesNotContain("import GlobalSafeTarget =", printed, StringComparison.Ordinal)
        Assert.Contains("func Make() SafeTarget", printed, StringComparison.Ordinal)
        Assert.Contains("return SafeTarget(6)", printed, StringComparison.Ordinal)
        Assert.Contains("SafeTarget.Shared()", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "System.Console.WriteLine(Holder.Read())", "8")
    }

    @Fact
    func TargetTypedDefaultPropertyAndIndexerAssignments_ReserveLateTargetTypeImport() {
        let printed = TranslateWithTestAssemblyReference(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class StringBuilder
        {
        }

        public static int Read(global::Signatures.TargetTypedDefaults api)
        {
            var builder = new global::System.Text.StringBuilder("one");
            api.Value = default;
            api[0] = default;
            return builder.Length;
        }
    }
}`)
        Assert.Contains("import Models", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Equal(2, CountOccurrences(printed, "default(TextStringBuilder)"))
    }

    @Fact
    func ConditionalNullArm_ReservesLateResultTypeImport() {
        let printed = TranslateWithTestAssemblyReference(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class StringBuilder
        {
        }

        public static int Read(
            global::Signatures.TargetTypedDefaults api,
            bool chooseValue)
        {
            var builder = new global::System.Text.StringBuilder("one");
            var selected = chooseValue ? api.Value : null;
            return builder.Length + (selected == null ? 1 : 0);
        }
    }
}`)
        Assert.Contains("import Models", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("default(TextStringBuilder?)", printed, StringComparison.Ordinal)
    }

    @Fact
    func TargetTypedCollectionPropertyAssignment_ReservesLateElementTypeImport() {
        let printed = TranslateWithTestAssemblyReference(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class StringBuilder
        {
        }

        public static int Read(global::Signatures.TargetTypedDefaults api)
        {
            var builder = new global::System.Text.StringBuilder("one");
            api.Values = [api.Value];
            return builder.Length + api.Values.Length;
        }
    }
}`)
        Assert.Contains("import Models", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("[]TextStringBuilder{api.Value!!}", printed, StringComparison.Ordinal)
    }

    @Fact
    func LambdaTargetSignature_ReservesLateParameterAndReturnTypeImport() {
        let printed = TranslateWithTestAssemblyReference(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class StringBuilder
        {
        }

        public static global::System.Text.StringBuilder MakeBuilder()
        {
            return new global::System.Text.StringBuilder("one");
        }

        public static int Read()
        {
            global::Signatures.Handler handler = value => value;
            return MakeBuilder().Length;
        }
    }
}`)
        Assert.Contains("import Models", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("let handler Handler = (value TextStringBuilder) -> value", printed, StringComparison.Ordinal)
    }

    @Fact
    func AnonymousMethodTargetSignature_ReservesLateParameterAndReturnTypeImport() {
        let printed = TranslateWithTestAssemblyReference(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class StringBuilder
        {
        }

        public static global::System.Text.StringBuilder MakeBuilder()
        {
            return new global::System.Text.StringBuilder("one");
        }

        public static int Read()
        {
            global::Signatures.ActionHandler handler = delegate
            {
            };
            return MakeBuilder().Length;
        }
    }
}`)
        Assert.Contains("import Models", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("let handler ActionHandler = (_ TextStringBuilder) -> {", printed, StringComparison.Ordinal)
    }

    @Fact
    func OptionalMethodArguments_ReserveLateParameterTypeImport() {
        let printed = TranslateWithTestAssemblyReference(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class StringBuilder
        {
        }

        public static int Read()
        {
            return global::Signatures.OptionalSignatureMethod.Read();
        }
    }
}`)
        Assert.Contains("import Models", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains(
            "OptionalSignatureMethod.Read(default(TextStringBuilder_2), default(TextStringBuilder), List[int32]())",
            printed,
            StringComparison.Ordinal
        )
    }

    @Fact
    func OptionalConstructorArguments_ReserveLateParameterTypeImport() {
        let printed = TranslateWithTestAssemblyReference(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class StringBuilder
        {
        }

        public static int Read()
        {
            return new global::Signatures.OptionalSignatureConstructor
            {
                Marker = 1,
            }.Value;
        }
    }
}`)
        Assert.Contains("import Models", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_2 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextStringBuilder = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains(
            "OptionalSignatureConstructor(default(TextStringBuilder_2), default(TextStringBuilder))",
            printed,
            StringComparison.Ordinal
        )
    }

    @Fact
    func OptionalEnumConstructorArgument_UsesLocatedAliasForMemberAndConversion() {
        let printed = TranslateWithTestAssemblyReference(`namespace Demo
{
    public sealed class Holder
    {
        public enum DayOfWeek
        {
            Local,
        }

        public static int Read()
        {
            return new global::Cs2Gs.Tests.Issue3466OptionalDayOfWeek
            {
                Marker = 1,
            }.Value;
        }
    }
}`)
        Assert.Contains("import SystemDayOfWeek = System.DayOfWeek", printed, StringComparison.Ordinal)
        Assert.Contains("SystemDayOfWeek(SystemDayOfWeek.Monday)", printed, StringComparison.Ordinal)
    }

    @Fact
    func BareCatch_NeedsNoExceptionAliasAtAll() {
        let printed = Translate(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class Exception
        {
        }

        public static int Read()
        {
            try
            {
                throw new global::System.InvalidOperationException();
            }
            catch
            {
                return 7;
            }
        }
    }
}`)
        // ADR-0177: a bare `catch` stays bare, so the translator names no
        // exception type here and a nested homonym has nothing to collide with.
        // The alias this test used to require existed only to spell the
        // synthesized `catch (__caught System.Exception)` binder.
        Assert.Contains("} catch {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__caught", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("SystemException_2", printed, StringComparison.Ordinal)
    }

    @Fact
    func SynthesizedSwitchThrow_MapsSystemInvalidOperationExceptionAtSourceLocation() {
        let printed = Translate(`namespace Demo
{
    public sealed class Holder
    {
        public sealed class InvalidOperationException
        {
        }

        public static int Read(bool value)
        {
            return value switch
            {
                true => 1,
                false => 0,
            };
        }
    }
}`)
        Assert.Contains(
            "import SystemInvalidOperationException = System.InvalidOperationException",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "SystemInvalidOperationException(\"Unmatched switch expression value.\")",
            printed,
            StringComparison.Ordinal
        )
    }

    shared {
        private func TranslateWithTestAssemblyReference(source string) string {
            let referencePath = typeof(TargetTypedDefaults).Assembly.Location
            let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
                .RuntimeReferences()
                .Append(MetadataReference.CreateFromFile(referencePath))
                .ToArray()
            using let resolver = ReferenceResolver.WithReferences([]string{referencePath})
            return Translate(source, references, resolver)
        }

        private func Translate(
            source string,
            references IReadOnlyList[MetadataReference]? = nil,
            bindReferences ReferenceResolver? = nil
        ) string -> Translate(
            "Snippet.cs",
            [](string, source string){("Snippet.cs", source)},
            references,
            bindReferences
        )

        private func Translate(
            targetFileName string,
            sources IReadOnlyList[(FileName string, Source string)],
            references IReadOnlyList[MetadataReference]? = nil,
            bindReferences ReferenceResolver? = nil
        ) string {
            let project = CSharpProjectLoader.LoadInMemory(sources, references)
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(
                project.Documents,
                (candidate LoadedDocument) -> candidate.FilePath == targetFileName
            )
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            if bindReferences == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.AssertBinds(bindReferences, printed)
            }
            return printed
        }

        private func CountOccurrences(value string, search string) int32 {
            var count = 0
            for var index = value.IndexOf(search, StringComparison.Ordinal); index >= 0; index = value.IndexOf(
                search,
                index + search.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }
    }
}

class TextStringBuilder {
    prop Value int32 -> 4
}

shared class Issue3466LateImportExtensions { }

@ExtensionOwner(typeof(Issue3466LateImportExtensions))
func (value string) Issue3466Length() int32 -> value.Length

@ExtensionOwner(typeof(Issue3466LateImportExtensions))
func (value string) Issue3466Length(offset int32) int32 -> value.Length + offset

class Issue3466OptionalDayOfWeek {
    init(day DayOfWeek = DayOfWeek.Monday) {
        this.Value = int32(day)
    }

    prop Value int32 {
        get;
    }

    prop Marker int32
}
