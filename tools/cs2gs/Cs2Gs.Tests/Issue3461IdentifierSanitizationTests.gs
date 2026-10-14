// <copyright file="Issue3461IdentifierSanitizationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import $class
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import GSharpSyntaxFacts = GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts
import GSharpSyntaxKind = GSharp.Core.CodeAnalysis.Syntax.SyntaxKind
import ImportedVisible
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// Issue #3461: every emitted identifier must avoid G# reserved spellings without collisions.
class Issue3461IdentifierSanitizationTests {
    @Fact
    func ImportedContextualFixtures_PreserveObliviousMethodsAndNullableMembers() {
        // The fixture types are pinned as a frozen C# snapshot (#4661), not read
        // from the Cs2Gs.Tests project, which is G# after the cut-over.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("ContextualStatics.cs", `using System;

namespace Cs2Gs.Tests;

` + FrozenCompilerSnapshots.Read("Issue3461ContextualStatics.cs.txt"))})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let methods INamedTypeSymbol? = project.Compilation.GetTypeByMetadataName(
            "Cs2Gs.Tests.ImportedContextualStatics"
        )
        Assert.NotNull(methods)
        let method = methods!!
            .GetMembers("base")
            .OfType[IMethodSymbol]()
            .Single((candidate IMethodSymbol) -> candidate.Arity == 1)
        let fields INamedTypeSymbol? = project.Compilation.GetTypeByMetadataName(
            "Cs2Gs.Tests.ImportedContextualStaticFields"
        )
        Assert.NotNull(fields)
        let field = fields!!.GetMembers("base").OfType[IFieldSymbol]().Single()
        Assert.Equal(NullableAnnotation.None, method.ReturnType.NullableAnnotation)
        Assert.Equal(NullableAnnotation.None, method.Parameters.Single().Type.NullableAnnotation)
        Assert.Equal(NullableAnnotation.Annotated, field.Type.NullableAnnotation)
    }

    @Fact
    func LanguageServerParamsParameter_DeclarationAndReference_Bind() {
        let rendered = Render(`using System.Text.Json;

public static class LspServer
{
    public static void Initialized(JsonElement @params)
    {
        _ = @params;
    }
}`)
        Assert.Contains("Initialized($$params JsonElement)", rendered, StringComparison.Ordinal)
        Assert.Contains("$$params", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered, `package System.Text.Json

struct JsonElement { }`)
    }

    @Fact
    func KeywordParameter_PreservesItsEmittedMetadataName() {
        let rendered = Render(`public class ScopeParameter
{
public int Read(int @scope) => @scope;
}`)
        Assert.Contains("func Read($$scope int32)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("scope_", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let emitted = EmittedOracle.Evaluate(rendered + Environment.NewLine + "1")
        Assert.Empty(emitted.Diagnostics)
        Assert.NotNull(emitted.Assembly)
        let read MethodInfo? = emitted.Assembly!!
            .GetTypes()
            .Single((type Type) -> type.Name == "ScopeParameter")
            .GetMethod("Read")
        Assert.NotNull(read)
        Assert.Equal("scope", Assert.Single(read!!.GetParameters()).Name)
    }

    @Fact
    func KeywordTypeParameters_PreserveTheirEmittedMetadataNames() {
        let rendered = Render(`public class GenericNames<@in>
{
    public @in Identity(@in value) => value;

    /// <summary>Uses <typeparamref name="scope"/>.</summary>
    /// <typeparam name="scope">The first type.</typeparam>
    /// <typeparam name="U">The result type.</typeparam>
    /// <param name="first">The first value.</param>
    /// <param name="value">The result value.</param>
    public U Echo<@scope, U>(@scope first, U value) => value;

    public string Name<@scope>() => nameof(@scope);
}`)
        Assert.Contains("class GenericNames[$$in]", rendered, StringComparison.Ordinal)
        Assert.Contains("Identity(value $$in) $$in -> value", rendered, StringComparison.Ordinal)
        Assert.True(
            rendered.Contains("Echo[$$scope, U](first $$scope, value U) U -> value", StringComparison.Ordinal),
            rendered
        )
        Assert.Contains("/// Uses `scope`.", rendered, StringComparison.Ordinal)
        Assert.Contains("@typeparam scope The first type.", rendered, StringComparison.Ordinal)
        Assert.Contains("@param first The first value.", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let emitted = EmittedOracle.Evaluate(rendered + Environment.NewLine + "1")
        Assert.Empty(emitted.Diagnostics)
        Assert.NotNull(emitted.Assembly)
        let genericType = emitted.Assembly!!.GetTypes().Single((type Type) -> type.Name == "GenericNames`1")
        Assert.Equal("in", Assert.Single(genericType.GetGenericArguments()).Name)
        let echo MethodInfo? = genericType.GetMethod("Echo")
        Assert.NotNull(echo)
        Assert.Equal([]string{"scope", "U"}, echo!!.GetGenericArguments().Select((parameter Type) -> parameter.Name))
        let closedType = genericType.MakeGenericType(typeof(int32))
        let instance object? = Activator.CreateInstance(closedType)
        Assert.Equal(7, closedType.GetMethod("Identity")!!.Invoke(instance, []object{7}))
        Assert.Equal(
            "ok",
            closedType.GetMethod("Echo")!!.MakeGenericMethod(typeof(int32), typeof(string)).Invoke(
                instance,
                []object{3, "ok"}
            )
        )
        Assert.Equal("scope", closedType.GetMethod("Name")!!.MakeGenericMethod(typeof(int32)).Invoke(instance, nil))
    }

    @Fact
    func ReservedAndSuffixIdentifiers_RemainDistinctAcrossSurfaces() {
        let rendered = Render(`using @import = System.Text.StringBuilder;
using import_ = System.Text.StringBuilder;

namespace Corpus.Issue3461
{
    public class @defer
    {
        public int Value;
    }

    public class defer_
    {
        public int Value;
    }

    public class Holder
    {
        private @import @scope = new @import();
        private import_ scope_ = new import_();

        public int @select(int @params, int params_, object value)
        {
            int @range = @params + this.@scope.Length;
            int range_ = params_ + this.scope_.Length;
            if (value is int @guard)
            {
                int guard_ = @guard + @range;
                if (guard_ > 0)
                {
                    goto @goto;
                }
            }

            goto goto_;

        @goto:
            return @range;

        goto_:
            return range_;
        }

        public int select_(int @params, int params_, object value) =>
            @select(@params, params_, value);

        public @defer MakeKeywordType() => new @defer();

        public defer_ MakeSuffixType() => new defer_();
    }
}`)
        Assert.Contains("import import_ = System.Text.StringBuilder", rendered, StringComparison.Ordinal)
        Assert.Contains("import import__ = System.Text.StringBuilder", rendered, StringComparison.Ordinal)
        // ADR-0170: the metadata-visible keyword-named class keeps its CLR
        // name via the escape; the legal `defer_` neighbor keeps its own name
        // — the #3461 collision is gone rather than allocated around.
        Assert.Contains("class $$defer", rendered, StringComparison.Ordinal)
        Assert.Contains("class defer_", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("defer__", rendered, StringComparison.Ordinal)
        Assert.Contains("$$select($$params int32, params_ int32", rendered, StringComparison.Ordinal)
        Assert.Contains("select_($$params int32, params_ int32", rendered, StringComparison.Ordinal)
        Assert.Contains("range_", rendered, StringComparison.Ordinal)
        Assert.Contains("range__", rendered, StringComparison.Ordinal)
        Assert.Contains("guard_", rendered, StringComparison.Ordinal)
        Assert.Contains("guard__", rendered, StringComparison.Ordinal)
        Assert.Contains("goto goto_", rendered, StringComparison.Ordinal)
        Assert.Contains("goto goto__", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func AnonymousGeneratedMembers_PreserveReservedNameCollisions() {
        let rendered = Render(`public static class Holder
{
    public static int Sum()
    {
        var value = new { @params = 1, params_ = 2 };
        return value.@params + value.params_;
    }
}`)
        Assert.Contains("params_ int32", rendered, StringComparison.Ordinal)
        Assert.Contains("params__ int32", rendered, StringComparison.Ordinal)
        Assert.Contains(".params_", rendered, StringComparison.Ordinal)
        Assert.Contains(".params__", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func LexerAndParserReservedWordAudit_AllNamesAreSanitized() {
        let reserved = Enum
            .GetValues[GSharpSyntaxKind]()
            .Select(GSharpSyntaxFacts.GetText)
            .Where(
            (text string) -> text != nil && GSharpSyntaxFacts.GetKeywordKind(text) != GSharpSyntaxKind.IdentifierToken
        )
            .Distinct(StringComparer.Ordinal)
            .OrderBy((text string) -> text, StringComparer.Ordinal)
            .ToArray()
        let declarations = string.Join(Environment.NewLine, reserved.Select((word string) -> "    public int @$word;"))
        let references = string.Join(" + ", reserved.Select((word string) -> "this.@$word"))
        let rendered = Render((`public class ReservedAudit
{
` + "$declarations" + `

    public int Sum() => ` + "$references" + `;
}`))
        for word in reserved {
            // ADR-0170: fields are metadata-visible, so every reserved name
            // keeps its CLR spelling via the `$` escape instead of a rename.
            Assert.Contains("$$" + word, rendered, StringComparison.Ordinal)
            Assert.DoesNotContain(word + "_", rendered, StringComparison.Ordinal)
            Assert.DoesNotContain("var $word ", rendered, StringComparison.Ordinal)
            Assert.DoesNotMatch("\\.${Regex.Escape(word)}(?![A-Za-z0-9_])", rendered)
        }
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func ContextualGrammarNames_UseEscapesForMetadataParameters() {
        let rendered = Render(`using System;

public class @event { }

public class MemberNames
{
    public int @nameof() => 1;

    public int @checked() => 2;

    public int @typeof() => 3;

    public int @sizeof() => 4;

    public int @unchecked() => 5;

    public int @make() => 6;

    public int @init() => 7;
}

public class Holder<@in, @out>
{
    private static int @checked() => 2;

    private static int @typeof() => 3;

    private static int @sizeof() => 4;

    private static int @unchecked() => 5;

    private static int @init() => 6;

    private static int @make() => 7;

    public int Run(int @params, int @scoped, int @ref, int @out, int @in)
    {
        Func<int, int> lambda = (int @params) => @params;
        int paramsLocal = @params;
        return @checked() + @typeof() + @sizeof() + @unchecked() +
            @init() + @make() + lambda(paramsLocal);
    }

    public int MemberCalls(MemberNames names) =>
        names.@nameof() + names.@checked() + names.@typeof() +
        names.@sizeof() + names.@unchecked() + names.@make() + names.@init();

    public @event Echo(@event value) => value;
}`)
        Assert.Contains("class $$event", rendered, StringComparison.Ordinal)
        Assert.Contains("class Holder[$$in, $$out]", rendered, StringComparison.Ordinal)
        Assert.Contains(
            "Run($$params int32, $$scoped int32, $$ref int32, $$out int32, $$in int32)",
            rendered,
            StringComparison.Ordinal
        )
        Assert.True(rendered.Split("$$params int32", StringSplitOptions.None).Length >= 3, rendered)
        Assert.Contains("func $$checked()", rendered, StringComparison.Ordinal)
        Assert.Contains("func $$typeof()", rendered, StringComparison.Ordinal)
        Assert.Contains("func $$sizeof()", rendered, StringComparison.Ordinal)
        Assert.Contains("func $$unchecked()", rendered, StringComparison.Ordinal)
        Assert.Contains("func $$init()", rendered, StringComparison.Ordinal)
        Assert.Contains("func make()", rendered, StringComparison.Ordinal)
        Assert.Contains("names.nameof()", rendered, StringComparison.Ordinal)
        Assert.Contains("names.checked()", rendered, StringComparison.Ordinal)
        Assert.Contains("names.typeof()", rendered, StringComparison.Ordinal)
        Assert.Contains("names.sizeof()", rendered, StringComparison.Ordinal)
        Assert.Contains("names.unchecked()", rendered, StringComparison.Ordinal)
        Assert.Contains("names.make()", rendered, StringComparison.Ordinal)
        Assert.Contains("names.$$init()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("func nameof_()", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func InterfaceContract_CollisionUsesOneAllocatedNameAtRuntime() {
        let rendered = Render(`public interface IValue
{
    int @defer();
}

public sealed class Value : IValue
{
    public int defer_() => 100;

    public int @defer() => 7;
}

public static class Holder
{
    public static int Run()
    {
        IValue value = new Value();
        return value.@defer() + new Value().defer_();
    }
}`)
        // ADR-0170: both contract endpoints keep the CLR name via the
        // escape; the legal defer_ sibling keeps its own name.
        Assert.Equal(2, rendered.Split("func $$defer()", StringSplitOptions.None).Length - 1)
        Assert.Contains("func defer_()", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(107, result.Value)
    }

    @Fact
    func OverrideContract_CollisionUsesOneAllocatedNameAtRuntime() {
        let rendered = Render(`public class Base
{
    public virtual int @defer() => 1;
}

public sealed class Derived : Base
{
    public int defer_() => 200;

    public override int @defer() => 9;
}

public static class Holder
{
    public static int Run()
    {
        Base value = new Derived();
        return value.@defer() + new Derived().defer_();
    }
}`)
        // ADR-0170: base virtual and override keep the CLR name via the
        // escape; the legal defer_ sibling keeps its own name.
        Assert.Equal(2, rendered.Split("func $$defer()", StringSplitOptions.None).Length - 1)
        Assert.Contains("func defer_()", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(209, result.Value)
    }

    @Fact
    func InheritedLegalName_ReservesDerivedIllegalAllocationAtRuntime() {
        let rendered = Render(`public class Base
{
    public int defer_() => 100;
}

public sealed class Derived : Base
{
    public int @defer() => 7;
}

public static class Holder
{
    public static int Run()
    {
        var value = new Derived();
        return value.@defer() + value.defer_();
    }
}`)
        // ADR-0170: the derived keyword-named method escapes to keep its CLR
        // name; no allocation around the inherited legal defer_ is needed.
        Assert.Contains("func $$defer()", rendered, StringComparison.Ordinal)
        Assert.Contains("func defer_()", rendered, StringComparison.Ordinal)
        Assert.Contains("value.$$defer()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("defer__", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(107, result.Value)
    }

    @Fact
    func RecordPrimaryParameter_SharesTypeMemberCollisionScope() {
        let rendered = Render(`public record R(int @params)
{
    public int params_ => 100;
}

public static class Holder
{
    public static int Run()
    {
        var value = new R(7);
        return value.@params + value.params_;
    }
}`)
        // ADR-0170: the positional property is metadata-visible, so the whole
        // parameter/property contract group keeps the CLR name via the escape.
        Assert.Contains("data class R($$params int32)", rendered, StringComparison.Ordinal)
        Assert.Contains("prop params_", rendered, StringComparison.Ordinal)
        Assert.Contains("value.$$params", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(107, result.Value)
    }

    @Fact
    func ClassPrimaryParameter_SharesTypeMemberCollisionScope() {
        let rendered = Render(`public class C(int @params)
{
    public int params_ => 100;

    public int Read() => @params + params_;
}

public static class Holder
{
    public static int Run() => new C(7).Read();
}`)
        Assert.Contains("class C($$params int32)", rendered, StringComparison.Ordinal)
        Assert.Contains("prop params_", rendered, StringComparison.Ordinal)
        Assert.Contains("$$params + params_", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(107, result.Value)
    }

    @Fact
    func LexicalNames_ReserveVisibleInstanceAndStaticMembers() {
        let rendered = Render(`public sealed class InstanceNames
{
    public int params_ = 100;

    public int defer_ => 200;

    public int Run(int @params)
    {
        int @defer = 7;
        return @params + this.params_ + @defer + this.defer_;
    }
}

public static class StaticNames
{
    public static int params_ = 1000;

    public static int Run(int @params) => @params + params_;
}

public static class Holder
{
    public static int Run() =>
        new InstanceNames().Run(3) + StaticNames.Run(5);
}`)
        Assert.Contains("Run($$params int32)", rendered, StringComparison.Ordinal)
        Assert.Contains("let defer__ = 7", rendered, StringComparison.Ordinal)
        Assert.Contains("$$params + this.params_", rendered, StringComparison.Ordinal)
        Assert.Contains("defer__ + this.defer_", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1315, result.Value)
    }

    @Fact
    func MethodTypeParameters_ReserveContainingTypeParameters() {
        let rendered = Render(`public sealed class C<defer_>
{
    public @defer Echo<@defer>(defer_ outer, @defer inner) => inner;
}

public static class Holder
{
    public static string Run() => new C<int>().Echo<string>(1, "ok");
}`)
        Assert.Contains("class C[defer_]", rendered, StringComparison.Ordinal)
        Assert.Contains("Echo[$$defer](outer defer_, inner $$defer)", rendered, StringComparison.Ordinal)
        Assert.Contains("Echo[string](1, \"ok\")", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func MethodTypeParameters_ReserveVisibleNestedTypes() {
        let rendered = Render(`public sealed class C
{
    public sealed class defer_ { }

    public @defer Echo<@defer>(defer_ outer, @defer inner) => inner;
}

public static class Holder
{
    public static string Run() =>
        new C().Echo<string>(new C.defer_(), "ok");
}`)
        Assert.Contains("class defer_", rendered, StringComparison.Ordinal)
        Assert.Contains("Echo[$$defer](outer defer_, inner $$defer)", rendered, StringComparison.Ordinal)
        Assert.Contains("Echo[string](C.defer_(), \"ok\")", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func MethodTypeParameters_ReserveSameNamespaceTypes() {
        let rendered = Render(`namespace Demo;

public sealed class defer_ { }

public sealed class C
{
    public @defer Echo<@defer>(defer_ outer, @defer inner) => inner;
}

public static class Holder
{
    public static string Run() =>
        new C().Echo<string>(new defer_(), "ok");
}`)
        Assert.Contains("class defer_", rendered, StringComparison.Ordinal)
        Assert.Contains("Echo[$$defer](outer defer_, inner $$defer)", rendered, StringComparison.Ordinal)
        Assert.Contains("Echo[string](defer_(), \"ok\")", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func MethodTypeParameters_ReserveUsingAliases() {
        let rendered = Render(`using defer_ = System.String;

public sealed class C
{
    public @defer Echo<@defer>(defer_ outer, @defer inner) => inner;
}

public static class Holder
{
    public static string Run() =>
        new C().Echo<string>("outer", "ok");
}`)
        Assert.Contains("Echo[$$defer](outer string, inner $$defer)", rendered, StringComparison.Ordinal)
        Assert.Contains("Echo[string](\"outer\", \"ok\")", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func MethodTypeParameters_ReserveImportedNamespaceTypes() {
        let fixtureAssembly = typeof(ImportedVisible.defer_).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray()
        let rendered = Render(`using ImportedVisible;

public sealed class C
{
    public @defer Echo<@defer>(defer_ outer, @defer inner) => inner;
}

public static class Holder
{
    public static string Run() =>
        new C().Echo<string>(new defer_(), "ok");
}`, references)
        Assert.Contains("Echo[$$defer](outer defer_, inner $$defer)", rendered, StringComparison.Ordinal)
        Assert.Contains("Echo[string](defer_(), \"ok\")", rendered, StringComparison.Ordinal)
        using let resolver = ReferenceResolver.WithReferences([]string{fixtureAssembly})
        TranslationTestValidation.AssertBinds(resolver, rendered)
        let result = EmittedOracle.Evaluate(
            []string{rendered + Environment.NewLine + "Holder.Run()"},
            EmittedOracleOptions{References: []string{fixtureAssembly}}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func ConsumerBeforeRecord_UsesPrecomputedPrimaryParameterName() {
        let rendered = RenderFiles(("Consumer.cs", `public static class Holder
{
    public static int Read(R value) => value.@params;
}`), ("Record.cs", `public record R
{
    public int @params { get; set; } = 7;
}`))
        Assert.Contains(".$$params", rendered["Consumer.cs"], StringComparison.Ordinal)
        Assert.Contains("data class R($$params", rendered["Record.cs"], StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered.Values.ToArray())
    }

    @Fact
    func GenericBaseAndStackallocNames_AreAllocated() {
        let rendered = Render(`public class @base<T> { }
public class @stackalloc<T> { }

public static class CallHolder
{
    private static T @base<T>(T value) => value;
    private static T @stackalloc<T>(T value) => value;

    public static int Run()
    {
        return @base<int>(1) + @stackalloc<int>(2);
    }
}

public static class CreateHolder
{
    public static void Run()
    {
        _ = new @base<int>();
        _ = new @stackalloc<int>();
    }
}`)
        Assert.Contains("class $$base", rendered, StringComparison.Ordinal)
        Assert.Contains("class $$stackalloc", rendered, StringComparison.Ordinal)
        Assert.Contains("func $$base[T]", rendered, StringComparison.Ordinal)
        Assert.Contains("func $$stackalloc[T]", rendered, StringComparison.Ordinal)
        Assert.Contains("$$base[int32](1)", rendered, StringComparison.Ordinal)
        Assert.Contains("$$stackalloc[int32](2)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func SourceExtensionNamespace_UsesAllocatedImport() {
        let rendered = RenderFiles(("GlobalUsings.cs", "global using @class;"), ("Extensions.cs", `namespace @class;

public static class Extensions
{
    public static int CountLetters(this string value) => value.Length;
}`), ("Consumer.cs", `namespace Consumer;

public static class Holder
{
    public static int Run() => "abc".CountLetters();
}`))
        Assert.Contains("package $$class", rendered["Extensions.cs"], StringComparison.Ordinal)
        Assert.Contains("import $$class", rendered["Consumer.cs"], StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered.Values.ToArray())
    }

    @Fact
    func ImportedClrMemberCollisionsAndMake_PreserveMetadataIdentityAtRuntime() {
        let fixtureAssembly = typeof(ImportedIdentifierFields).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray()
        let rendered = Render(`using Cs2Gs.Tests;

public static class Holder
{
    public static int Run()
    {
        var fields = new ImportedIdentifierFields();
        var properties = new ImportedIdentifierProperties();
        var methods = new ImportedIdentifierMethods();
        return fields.@defer + fields.defer_ +
            properties.@defer + properties.defer_ +
            methods.@defer() + methods.defer_() + methods.@make();
    }
}`, references)
        Assert.Contains("fields.$$defer", rendered, StringComparison.Ordinal)
        Assert.Contains("fields.defer_", rendered, StringComparison.Ordinal)
        Assert.Contains("properties.$$defer", rendered, StringComparison.Ordinal)
        Assert.Contains("methods.$$defer()", rendered, StringComparison.Ordinal)
        Assert.Contains("methods.make()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("methods.make_()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("defer__", rendered, StringComparison.Ordinal)
        using let resolver = ReferenceResolver.WithReferences([]string{fixtureAssembly})
        TranslationTestValidation.AssertBinds(resolver, rendered)
        let result = EmittedOracle.Evaluate(
            []string{rendered + Environment.NewLine + "Holder.Run()"},
            EmittedOracleOptions{References: []string{fixtureAssembly}}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(54, result.Value)
    }

    @Fact
    func ImportedStaticContextualCalls_AreQualifiedAndRun() {
        let fixtureAssembly = typeof(ImportedContextualStatics).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray()
        let rendered = Render(`using static Cs2Gs.Tests.ImportedContextualStatics;

public static class Holder
{
    public static int Run() =>
        @nameof() + @typeof() + @sizeof() + @checked() + @unchecked() +
        @base<int>(1) + @stackalloc<int>(2) + @nameof<int>(4);
}`, references)
        Assert.Contains("ImportedContextualStatics.nameof()", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStatics.typeof()", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStatics.sizeof()", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStatics.checked()", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStatics.unchecked()", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStatics.base[int32](1)", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStatics.stackalloc[int32](2)", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStatics.nameof[int32](4)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("func nameof", rendered, StringComparison.Ordinal)
        using let resolver = ReferenceResolver.WithReferences([]string{fixtureAssembly})
        TranslationTestValidation.AssertBinds(resolver, rendered)
        let result = EmittedOracle.Evaluate(
            []string{rendered + Environment.NewLine + "Holder.Run()"},
            EmittedOracleOptions{References: []string{fixtureAssembly}}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(38, result.Value)
    }

    @Fact
    func ImportedStaticContextualFields_AreQualifiedAndRun() {
        let fixtureAssembly = typeof(ImportedContextualStaticFields).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray()
        let rendered = Render(`using static Cs2Gs.Tests.ImportedContextualStaticFields;

public static class Holder
{
    public static int Run() => @base[0] + @stackalloc[0] + @nameof();
}`, references)
        Assert.Contains("ImportedContextualStaticFields.base!![0]", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStaticFields.stackalloc!![0]", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStaticFields.nameof!!()", rendered, StringComparison.Ordinal)
        using let resolver = ReferenceResolver.WithReferences([]string{fixtureAssembly})
        TranslationTestValidation.AssertBinds(resolver, rendered)
        let result = EmittedOracle.Evaluate(
            []string{rendered + Environment.NewLine + "Holder.Run()"},
            EmittedOracleOptions{References: []string{fixtureAssembly}}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(15, result.Value)
    }

    @Fact
    func ImportedStaticContextualProperties_AreQualifiedAndRun() {
        let fixtureAssembly = typeof(ImportedContextualStaticProperties).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray()
        let rendered = Render(`using static Cs2Gs.Tests.ImportedContextualStaticProperties;

public static class Holder
{
    public static int Run() => @base[0] + @stackalloc[0] + @nameof();
}`, references)
        Assert.Contains("ImportedContextualStaticProperties.base!![0]", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStaticProperties.stackalloc!![0]", rendered, StringComparison.Ordinal)
        Assert.Contains("ImportedContextualStaticProperties.nameof!!()", rendered, StringComparison.Ordinal)
        using let resolver = ReferenceResolver.WithReferences([]string{fixtureAssembly})
        TranslationTestValidation.AssertBinds(resolver, rendered)
        let result = EmittedOracle.Evaluate(
            []string{rendered + Environment.NewLine + "Holder.Run()"},
            EmittedOracleOptions{References: []string{fixtureAssembly}}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(18, result.Value)
    }

    @Fact
    func ImportedReservedNamespaceAndTypes_ResolveCanonicalMetadataNames() {
        let fixtureAssembly = typeof($defer).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray()
        let rendered = Render(`using @class;

public static class Holder
{
    public static int Run() => new @defer().Value + new defer_().Value;
}`, references)
        Assert.Contains("import $$class", rendered, StringComparison.Ordinal)
        Assert.Contains("$$defer()", rendered, StringComparison.Ordinal)
        Assert.Contains("defer_()", rendered, StringComparison.Ordinal)
        using let resolver = ReferenceResolver.WithReferences([]string{fixtureAssembly})
        TranslationTestValidation.AssertBinds(resolver, rendered)
        let result = EmittedOracle.Evaluate(
            []string{rendered + Environment.NewLine + "Holder.Run()"},
            EmittedOracleOptions{References: []string{fixtureAssembly}}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func BareIndexContextualNames_AreAllocated() {
        let rendered = Render(`public static class Holder
{
    public static int Read(int[] @stackalloc, int[] @base)
    {
        return @stackalloc[0] + @base[0];
    }
}`)
        Assert.Contains("Read($$stackalloc []int32, $$base []int32)", rendered, StringComparison.Ordinal)
        Assert.Contains("$$stackalloc[0]", rendered, StringComparison.Ordinal)
        Assert.Contains("$$base[0]", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func LegalPublicSuffixedNames_RemainUnchanged() {
        let rendered = Render(`namespace defer_;

public class defer_ { }

public class Holder
{
    public int defer_;

    public defer_ Echo(defer_ defer_)
    {
        this.defer_ = 1;
        return defer_;
    }
}`)
        Assert.Contains("package defer_", rendered, StringComparison.Ordinal)
        Assert.Contains("class defer_ {", rendered, StringComparison.Ordinal)
        Assert.Contains("var defer_ int32", rendered, StringComparison.Ordinal)
        Assert.Contains("Echo(defer_ defer_) defer_", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("defer__", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func TypeContextualNames_AreAllocatedInTypeClausesAndConstruction() {
        let rendered = Render(`public class @event { }
public class @prop { }
public class @init { }
public class @convenience { }
public class @shared { }
public class @delegate { }
public class @unmanaged { }

public static class Holder
{
    public static @event Event() => new @event();
    public static @prop Prop() => new @prop();
    public static @init Init() => new @init();
    public static @convenience Convenience() => new @convenience();
    public static @shared Shared() => new @shared();
    public static @delegate Delegate() => new @delegate();
    public static @unmanaged Unmanaged() => new @unmanaged();
}`)
        for (method, name) in[](string, string){
            ("Event", "$$event"),
            ("Prop", "$$prop"),
            ("Init", "$$init"),
            ("Convenience", "$$convenience"),
            ("Shared", "$$shared"),
            ("Delegate", "$$delegate"),
            ("Unmanaged", "$$unmanaged")
        } {
            Assert.Contains("class $name", rendered, StringComparison.Ordinal)
            Assert.Contains("func $method() $name -> $name()", rendered, StringComparison.Ordinal)
        }
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func PatternContextualNames_DeclarationAndReferencesBind() {
        let rendered = Render(`public static class Holder
{
    public static int When(object value)
    {
        if (value is int @when)
        {
            return @when;
        }

        return 0;
    }

    public static int And(object value)
    {
        if (value is int @and)
        {
            return @and;
        }

        return 0;
    }

    public static int Or(object value)
    {
        if (value is int @or)
        {
            return @or;
        }

        return 0;
    }
}`)
        Assert.Contains("int32 when_", rendered, StringComparison.Ordinal)
        Assert.Contains("int32 and_", rendered, StringComparison.Ordinal)
        Assert.Contains("int32 or_", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func UnicodeEscapedIdentifiers_UseValueTextAndBind() {
        let rendered = Render(`public class cl\u0061ss
{
    public int p\u0061rams;

    public int Read(int p\u0061rams)
    {
        int ordin\u0061ry = p\u0061rams;
        this.p\u0061rams = ordin\u0061ry;
        return this.p\u0061rams;
    }
}`)
        Assert.Contains("class $$class", rendered, StringComparison.Ordinal)
        Assert.Contains("var params int32", rendered, StringComparison.Ordinal)
        Assert.Contains("Read($$params int32)", rendered, StringComparison.Ordinal)
        Assert.Contains("let ordinary", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("\\u", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func NameofReservedParameter_PreservesSourceStringAtRuntime() {
        let rendered = Render(`public static class Holder
{
    public static string Read(int @params) => nameof(@params);
}`)
        Assert.Contains("Read($$params int32)", rendered, StringComparison.Ordinal)
        Assert.Contains("\"params\"", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("nameof(", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Read(1)")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("params", result.Value)
    }

    @Fact
    func SourceNamespaceSegments_AliasesAndQualifiedReferencesBind() {
        let rendered = RenderFiles(("Producer.cs", `namespace @class;

public class Widget { }`), ("Consumer.cs", `using @import = @class.Widget;

namespace Consumer;

public class Holder
{
    public @class.Widget Direct() => new @class.Widget();

    public @import Aliased() => new @import();
}`))
        Assert.Contains("package $$class", rendered["Producer.cs"], StringComparison.Ordinal)
        Assert.Contains("import import_ = $$class.Widget", rendered["Consumer.cs"], StringComparison.Ordinal)
        Assert.DoesNotContain("@class", rendered["Consumer.cs"], StringComparison.Ordinal)
        Assert.DoesNotContain("@import", rendered["Consumer.cs"], StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered.Values.ToArray())
    }

    @Fact
    func ImportedAttributeNamedArguments_UseAllocatedNames() {
        let fixtureAssembly = typeof(ReservedNamedAttribute).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray()
        let rendered = Render(`using Cs2Gs.Tests;

[ReservedNamed("a", "b", @defer = "c", defer_ = "d")]
public class Holder { }`, references)
        Assert.Contains(
            "@ReservedNamed(\"a\", \"b\", $$defer = \"c\", defer_ = \"d\")",
            rendered,
            StringComparison.Ordinal
        )
        using let resolver = ReferenceResolver.WithReferences([]string{fixtureAssembly})
        TranslationTestValidation.AssertBinds(resolver, rendered)
    }

    @Fact
    func EscapedReservedSourceAttributeName_DeclarationAndUseBind() {
        let rendered = Render(`using System;

public sealed class @class : Attribute
{
    public @class(string value) { }
}

[@class("ok")]
public sealed class Holder { }`)
        Assert.Contains("class $$class", rendered, StringComparison.Ordinal)
        Assert.Contains("@$$class(\"ok\")", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    /// Issue #3610 / ADR-0170 follow-up: the repository-mode
    /// package-split path resolves each split unit's package through
    /// `ResolvePackageName` with the C# DISPLAY spelling of the
    /// namespace (`@class` from `ToDisplayString`). The symbol
    /// walk must compare the bare metadata name so a keyword-named
    /// namespace prints as the G# `$class` escape — the raw `@`
    /// text does not round-trip-parse (the Cs2Gs.Tests selfmig AtToken
    /// wall in the 2026-08-28 nightly).
    @Fact
    func PackageSplit_KeywordNamespace_PrintsEscapedPackage() {
        const source = `namespace @class
{
    public sealed class @defer
    {
        public int Value => 19;
    }
}

namespace Other
{
    public sealed class Marker
    {
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Issue3461Split.cs", source)})
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        // The pipeline hands the split translator ToDisplayString packages.
        let packages = CSharpToGSharpTranslator.GetDeclaredPackages(document)
        Assert.Contains("@class", packages)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let splitTranslator = CSharpToGSharpTranslator(packageFilter: "@class")
        let printed = GSharpPrinter.Print(splitTranslator.TranslateDocument(document, context))
        Assert.Contains("package $$class", printed)
        Assert.DoesNotContain("@class", printed)
        Assert.Contains("class $$defer", printed)
    }

    shared {
        private func Render(source string, references IReadOnlyList[MetadataReference]? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Issue3461.cs", source)},
                references
            )
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        private func RenderFiles(sources ...(FileName string, Source string)) IReadOnlyDictionary[string, string] {
            let project = CSharpProjectLoader.LoadInMemory(sources)
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let translator = CSharpToGSharpTranslator()
            return project.Documents.ToDictionary(
                func (document LoadedDocument) string {
                    return document.FilePath
                },
                (document LoadedDocument) -> {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    return GSharpPrinter.Print(translator.TranslateDocument(document, context))
                },
                StringComparer.Ordinal
            )
        }
    }
}

/// Imported attribute fixture with reserved and colliding CLR names.
class ReservedNamedAttribute : Attribute {
    /// Initializes a new instance.
    init($params string, params_ string) { }

    /// Gets or sets reserved-name data.
    prop $defer string

    /// Gets or sets colliding legal-name data.
    prop defer_ string
}

/// Imported CLR field fixture with colliding names.
class ImportedIdentifierFields {
    /// Reserved-name field.
    var $defer int32 = 3

    /// Legal colliding field.
    var defer_ int32 = 5
}

/// Imported CLR property fixture with colliding names.
class ImportedIdentifierProperties {
    /// Reserved-name property.
    prop $defer int32 -> 7

    /// Legal colliding property.
    prop defer_ int32 -> 11
}

/// Imported CLR method fixture with colliding and contextual names.
class ImportedIdentifierMethods {
    /// Reserved-name method.
    func $defer() int32 -> 13

    /// Legal colliding method.
    func defer_() int32 -> 15

    /// Contextual method name legal after member access.
    func make() int32 -> 0
}

/// Imported static contextual method fixture.
shared class ImportedContextualStatics {
    /// Returns one.
    func nameof() int32 -> 1

    /// Returns two.
    func typeof() int32 -> 2

    /// Returns four.
    func sizeof() int32 -> 4

    /// Returns eight.
    func checked() int32 -> 8

    /// Returns sixteen.
    func unchecked() int32 -> 16

    /// Returns generic value.
    func base[T](value T) T -> value

    /// Returns generic value.
    func stackalloc[T](value T) T -> value

    /// Returns generic value.
    func nameof[T](value T) T -> value
}

/// Imported contextual static field fixture.
shared class ImportedContextualStaticFields {
    /// Reserved index-prefix field.
    let base[]?int32 = []int32{3}

    /// Reserved index-prefix field.
    let stackalloc[]?int32 = []int32{5}

    /// Reserved invocation field.
    let nameof(() -> int32)? = () -> 7
}

/// Imported contextual static property fixture.
shared class ImportedContextualStaticProperties {
    /// Reserved index-prefix property.
    private let _base[]?int32 = []int32{4}

    prop base[]?int32 {
        get {
            return _base
        }
    }

    /// Reserved index-prefix property.
    private let _stackalloc[]?int32 = []int32{6}

    prop stackalloc[]?int32 {
        get {
            return _stackalloc
        }
    }

    /// Reserved invocation property.
    private let _nameof(() -> int32)? = () -> 8

    prop nameof(() -> int32)? {
        get {
            return _nameof
        }
    }
}
