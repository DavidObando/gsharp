// <copyright file="Issue3461IdentifierSanitizationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;
using GSharpSyntaxFacts = GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts;
using GSharpSyntaxKind = GSharp.Core.CodeAnalysis.Syntax.SyntaxKind;

namespace Cs2Gs.Tests;

/// <summary>Issue #3461: every emitted identifier must avoid G# reserved spellings without collisions.</summary>
public sealed class Issue3461IdentifierSanitizationTests
{
    [Fact]
    public void LanguageServerParamsParameter_DeclarationAndReference_Bind()
    {
        string rendered = Render(
            """
            using System.Text.Json;

            public static class LspServer
            {
                public static void Initialized(JsonElement @params)
                {
                    _ = @params;
                }
            }
            """);

        Assert.Contains("Initialized(params_ JsonElement)", rendered, StringComparison.Ordinal);
        AssertNoStandaloneIdentifier(rendered, "params");
        TranslationTestValidation.AssertBinds(
            rendered,
            """
            package System.Text.Json

            struct JsonElement { }
            """);
    }

    [Fact]
    public void ReservedAndSuffixIdentifiers_RemainDistinctAcrossSurfaces()
    {
        string rendered = Render(
            """
            using @import = System.Text.StringBuilder;
            using import_ = System.Text.StringBuilder;

            namespace Corpus.Issue3461
            {
                public class @type
                {
                    public int Value;
                }

                public class type_
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

                    public @type MakeKeywordType() => new @type();

                    public type_ MakeSuffixType() => new type_();
                }
            }
            """);

        Assert.Contains("import import_ = System.Text.StringBuilder", rendered, StringComparison.Ordinal);
        Assert.Contains("import import__ = System.Text.StringBuilder", rendered, StringComparison.Ordinal);
        Assert.Contains("class type_", rendered, StringComparison.Ordinal);
        Assert.Contains("class type__", rendered, StringComparison.Ordinal);
        Assert.Contains("select_(params__ int32, params_ int32", rendered, StringComparison.Ordinal);
        Assert.Contains("select__(params__ int32, params_ int32", rendered, StringComparison.Ordinal);
        Assert.Contains("range_", rendered, StringComparison.Ordinal);
        Assert.Contains("range__", rendered, StringComparison.Ordinal);
        Assert.Contains("guard_", rendered, StringComparison.Ordinal);
        Assert.Contains("guard__", rendered, StringComparison.Ordinal);
        Assert.Contains("goto goto_", rendered, StringComparison.Ordinal);
        Assert.Contains("goto goto__", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void AnonymousGeneratedMembers_PreserveReservedNameCollisions()
    {
        string rendered = Render(
            """
            public static class Holder
            {
                public static int Sum()
                {
                    var value = new { @params = 1, params_ = 2 };
                    return value.@params + value.params_;
                }
            }
            """);

        Assert.Contains("params_ int32", rendered, StringComparison.Ordinal);
        Assert.Contains("params__ int32", rendered, StringComparison.Ordinal);
        Assert.Contains(".params_", rendered, StringComparison.Ordinal);
        Assert.Contains(".params__", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void LexerAndParserReservedWordAudit_AllNamesAreSanitized()
    {
        string[] reserved = Enum.GetValues<GSharpSyntaxKind>()
            .Select(GSharpSyntaxFacts.GetText)
            .Where(text => text != null && GSharpSyntaxFacts.GetKeywordKind(text) != GSharpSyntaxKind.IdentifierToken)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(text => text, StringComparer.Ordinal)
            .ToArray();
        string declarations = string.Join(
            Environment.NewLine,
            reserved.Select(word => $"    public int @{word};"));
        string references = string.Join(" + ", reserved.Select(word => $"this.@{word}"));
        string rendered = Render(
            $$"""
            public class ReservedAudit
            {
            {{declarations}}

                public int Sum() => {{references}};
            }
            """);

        foreach (string word in reserved)
        {
            Assert.Contains(word + "_", rendered, StringComparison.Ordinal);
            Assert.DoesNotContain($"var {word} ", rendered, StringComparison.Ordinal);
            Assert.DoesNotMatch(
                $@"\.{Regex.Escape(word)}(?![A-Za-z0-9_])",
                rendered);
        }

        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ContextualGrammarNames_AreRenamedOnlyInUnsafeContexts()
    {
        string rendered = Render(
            """
            using System;

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
            }
            """);

        Assert.Contains("class event_", rendered, StringComparison.Ordinal);
        Assert.Contains("class Holder[in_, out_]", rendered, StringComparison.Ordinal);
        Assert.Contains(
            "Run(params_ int32, scoped_ int32, ref_ int32, out_ int32, in_ int32)",
            rendered,
            StringComparison.Ordinal);
        Assert.True(
            rendered.Split("params_ int32", StringSplitOptions.None).Length >= 3,
            rendered);
        Assert.Contains("func checked_()", rendered, StringComparison.Ordinal);
        Assert.Contains("func typeof_()", rendered, StringComparison.Ordinal);
        Assert.Contains("func sizeof_()", rendered, StringComparison.Ordinal);
        Assert.Contains("func unchecked_()", rendered, StringComparison.Ordinal);
        Assert.Contains("func init_()", rendered, StringComparison.Ordinal);
        Assert.Contains("func make()", rendered, StringComparison.Ordinal);
        Assert.Contains("names.nameof()", rendered, StringComparison.Ordinal);
        Assert.Contains("names.checked()", rendered, StringComparison.Ordinal);
        Assert.Contains("names.typeof()", rendered, StringComparison.Ordinal);
        Assert.Contains("names.sizeof()", rendered, StringComparison.Ordinal);
        Assert.Contains("names.unchecked()", rendered, StringComparison.Ordinal);
        Assert.Contains("names.make()", rendered, StringComparison.Ordinal);
        Assert.Contains("names.init_()", rendered, StringComparison.Ordinal);
        Assert.Contains("func init_()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("func nameof_()", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void InterfaceContract_CollisionUsesOneAllocatedNameAtRuntime()
    {
        string rendered = Render(
            """
            public interface IValue
            {
                int @type();
            }

            public sealed class Value : IValue
            {
                public int type_() => 100;

                public int @type() => 7;
            }

            public static class Holder
            {
                public static int Run()
                {
                    IValue value = new Value();
                    return value.@type() + new Value().type_();
                }
            }
            """);

        Assert.Equal(
            2,
            rendered.Split("func type__()", StringSplitOptions.None).Length - 1);
        Assert.Contains("func type_()", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void OverrideContract_CollisionUsesOneAllocatedNameAtRuntime()
    {
        string rendered = Render(
            """
            public class Base
            {
                public virtual int @type() => 1;
            }

            public sealed class Derived : Base
            {
                public int type_() => 200;

                public override int @type() => 9;
            }

            public static class Holder
            {
                public static int Run()
                {
                    Base value = new Derived();
                    return value.@type() + new Derived().type_();
                }
            }
            """);

        Assert.Equal(
            2,
            rendered.Split("func type__()", StringSplitOptions.None).Length - 1);
        Assert.Contains("func type_()", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(209, result.Value);
    }

    [Fact]
    public void InheritedLegalName_ReservesDerivedIllegalAllocationAtRuntime()
    {
        string rendered = Render(
            """
            public class Base
            {
                public int type_() => 100;
            }

            public sealed class Derived : Base
            {
                public int @type() => 7;
            }

            public static class Holder
            {
                public static int Run()
                {
                    var value = new Derived();
                    return value.@type() + value.type_();
                }
            }
            """);

        Assert.Contains("func type__()", rendered, StringComparison.Ordinal);
        Assert.Contains("func type_()", rendered, StringComparison.Ordinal);
        Assert.Contains("value.type__()", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void RecordPrimaryParameter_SharesTypeMemberCollisionScope()
    {
        string rendered = Render(
            """
            public record R(int @params)
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
            }
            """);

        Assert.Contains("data class R(params__ int32)", rendered, StringComparison.Ordinal);
        Assert.Contains("prop params_", rendered, StringComparison.Ordinal);
        Assert.Contains("value.params__", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void ClassPrimaryParameter_SharesTypeMemberCollisionScope()
    {
        string rendered = Render(
            """
            public class C(int @params)
            {
                public int params_ => 100;

                public int Read() => @params + params_;
            }

            public static class Holder
            {
                public static int Run() => new C(7).Read();
            }
            """);

        Assert.Contains("class C(params__ int32)", rendered, StringComparison.Ordinal);
        Assert.Contains("prop params_", rendered, StringComparison.Ordinal);
        Assert.Contains("params__ + params_", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void LexicalNames_ReserveVisibleInstanceAndStaticMembers()
    {
        string rendered = Render(
            """
            public sealed class InstanceNames
            {
                public int params_ = 100;

                public int type_ => 200;

                public int Run(int @params)
                {
                    int @type = 7;
                    return @params + this.params_ + @type + this.type_;
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
            }
            """);

        Assert.Contains("Run(params__ int32)", rendered, StringComparison.Ordinal);
        Assert.Contains("let type__ = 7", rendered, StringComparison.Ordinal);
        Assert.Contains("params__ + this.params_", rendered, StringComparison.Ordinal);
        Assert.Contains("type__ + this.type_", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1315, result.Value);
    }

    [Fact]
    public void MethodTypeParameters_ReserveContainingTypeParameters()
    {
        string rendered = Render(
            """
            public sealed class C<type_>
            {
                public @type Echo<@type>(type_ outer, @type inner) => inner;
            }

            public static class Holder
            {
                public static string Run() => new C<int>().Echo<string>(1, "ok");
            }
            """);

        Assert.Contains("class C[type_]", rendered, StringComparison.Ordinal);
        Assert.Contains("Echo[type__](outer type_, inner type__)", rendered, StringComparison.Ordinal);
        Assert.Contains("Echo[string](1, \"ok\")", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("ok", result.Value);
    }

    [Fact]
    public void MethodTypeParameters_ReserveVisibleNestedTypes()
    {
        string rendered = Render(
            """
            public sealed class C
            {
                public sealed class type_ { }

                public @type Echo<@type>(type_ outer, @type inner) => inner;
            }

            public static class Holder
            {
                public static string Run() =>
                    new C().Echo<string>(new C.type_(), "ok");
            }
            """);

        Assert.Contains("class type_", rendered, StringComparison.Ordinal);
        Assert.Contains("Echo[type__](outer type_, inner type__)", rendered, StringComparison.Ordinal);
        Assert.Contains("Echo[string](C.type_(), \"ok\")", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("ok", result.Value);
    }

    [Fact]
    public void ConsumerBeforeRecord_UsesPrecomputedPrimaryParameterName()
    {
        IReadOnlyDictionary<string, string> rendered = RenderFiles(
            ("Consumer.cs", """
                public static class Holder
                {
                    public static int Read(R value) => value.@params;
                }
                """),
            ("Record.cs", """
                public record R
                {
                    public int @params { get; set; } = 7;
                }
                """));

        Assert.Contains(".params_", rendered["Consumer.cs"], StringComparison.Ordinal);
        Assert.Contains("data class R(params_", rendered["Record.cs"], StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered.Values.ToArray());
    }

    [Fact]
    public void GenericBaseAndStackallocNames_AreAllocated()
    {
        string rendered = Render(
            """
            public class @base<T> { }
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
            }
            """);

        Assert.Contains("class base_", rendered, StringComparison.Ordinal);
        Assert.Contains("class stackalloc_", rendered, StringComparison.Ordinal);
        Assert.Contains("func base_[T]", rendered, StringComparison.Ordinal);
        Assert.Contains("func stackalloc_[T]", rendered, StringComparison.Ordinal);
        Assert.Contains("base_[int32](1)", rendered, StringComparison.Ordinal);
        Assert.Contains("stackalloc_[int32](2)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void SourceExtensionNamespace_UsesAllocatedImport()
    {
        IReadOnlyDictionary<string, string> rendered = RenderFiles(
            ("GlobalUsings.cs", "global using @class;"),
            ("Extensions.cs", """
                namespace @class;

                public static class Extensions
                {
                    public static int CountLetters(this string value) => value.Length;
                }
                """),
            ("Consumer.cs", """
                namespace Consumer;

                public static class Holder
                {
                    public static int Run() => "abc".CountLetters();
                }
                """));

        Assert.Contains("package class_", rendered["Extensions.cs"], StringComparison.Ordinal);
        Assert.Contains("import class_", rendered["Consumer.cs"], StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered.Values.ToArray());
    }

    [Fact]
    public void ImportedClrMemberCollisionsAndMake_PreserveMetadataIdentityAtRuntime()
    {
        string fixtureAssembly = typeof(ImportedIdentifierFields).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader.RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray();
        string rendered = Render(
            """
            using Cs2Gs.Tests;

            public static class Holder
            {
                public static int Run()
                {
                    var fields = new ImportedIdentifierFields();
                    var properties = new ImportedIdentifierProperties();
                    var methods = new ImportedIdentifierMethods();
                    return fields.@type + fields.type_ +
                        properties.@type + properties.type_ +
                        methods.@type() + methods.type_() + methods.@make();
                }
            }
            """,
            references);

        Assert.Contains("fields.type__", rendered, StringComparison.Ordinal);
        Assert.Contains("fields.type_", rendered, StringComparison.Ordinal);
        Assert.Contains("properties.type__", rendered, StringComparison.Ordinal);
        Assert.Contains("methods.type__()", rendered, StringComparison.Ordinal);
        Assert.Contains("methods.make()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("methods.make_()", rendered, StringComparison.Ordinal);

        using var resolver = ReferenceResolver.WithReferences(new[] { fixtureAssembly });
        TranslationTestValidation.AssertBinds(resolver, rendered);
        var result = EmittedOracle.Evaluate(
            new[] { rendered + Environment.NewLine + "Holder.Run()" },
            new EmittedOracleOptions { References = new[] { fixtureAssembly } });
        Assert.Empty(result.Diagnostics);
        Assert.Equal(54, result.Value);
    }

    [Fact]
    public void ImportedStaticContextualCalls_AreQualifiedAndRun()
    {
        string fixtureAssembly = typeof(ImportedContextualStatics).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader.RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray();
        string rendered = Render(
            """
            using static Cs2Gs.Tests.ImportedContextualStatics;

            public static class Holder
            {
                public static int Run() =>
                    @nameof() + @typeof() + @sizeof() + @checked() + @unchecked() +
                    @base<int>(1) + @stackalloc<int>(2) + @nameof<int>(4);
            }
            """,
            references);

        Assert.Contains("ImportedContextualStatics.nameof()", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStatics.typeof()", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStatics.sizeof()", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStatics.checked()", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStatics.unchecked()", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStatics.base[int32](1)", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStatics.stackalloc[int32](2)", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStatics.nameof[int32](4)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("func nameof", rendered, StringComparison.Ordinal);

        using var resolver = ReferenceResolver.WithReferences(new[] { fixtureAssembly });
        TranslationTestValidation.AssertBinds(resolver, rendered);
        var result = EmittedOracle.Evaluate(
            new[] { rendered + Environment.NewLine + "Holder.Run()" },
            new EmittedOracleOptions { References = new[] { fixtureAssembly } });
        Assert.Empty(result.Diagnostics);
        Assert.Equal(38, result.Value);
    }

    [Fact]
    public void ImportedStaticContextualFields_AreQualifiedAndRun()
    {
        string fixtureAssembly = typeof(ImportedContextualStaticFields).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader.RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray();
        string rendered = Render(
            """
            using static Cs2Gs.Tests.ImportedContextualStaticFields;

            public static class Holder
            {
                public static int Run() => @base[0] + @stackalloc[0] + @nameof();
            }
            """,
            references);

        Assert.Contains("ImportedContextualStaticFields.base!![0]", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStaticFields.stackalloc!![0]", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStaticFields.nameof!!()", rendered, StringComparison.Ordinal);

        using var resolver = ReferenceResolver.WithReferences(new[] { fixtureAssembly });
        TranslationTestValidation.AssertBinds(resolver, rendered);
        var result = EmittedOracle.Evaluate(
            new[] { rendered + Environment.NewLine + "Holder.Run()" },
            new EmittedOracleOptions { References = new[] { fixtureAssembly } });
        Assert.Empty(result.Diagnostics);
        Assert.Equal(15, result.Value);
    }

    [Fact]
    public void ImportedStaticContextualProperties_AreQualifiedAndRun()
    {
        string fixtureAssembly = typeof(ImportedContextualStaticProperties).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader.RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray();
        string rendered = Render(
            """
            using static Cs2Gs.Tests.ImportedContextualStaticProperties;

            public static class Holder
            {
                public static int Run() => @base[0] + @stackalloc[0] + @nameof();
            }
            """,
            references);

        Assert.Contains("ImportedContextualStaticProperties.base!![0]", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStaticProperties.stackalloc!![0]", rendered, StringComparison.Ordinal);
        Assert.Contains("ImportedContextualStaticProperties.nameof!!()", rendered, StringComparison.Ordinal);

        using var resolver = ReferenceResolver.WithReferences(new[] { fixtureAssembly });
        TranslationTestValidation.AssertBinds(resolver, rendered);
        var result = EmittedOracle.Evaluate(
            new[] { rendered + Environment.NewLine + "Holder.Run()" },
            new EmittedOracleOptions { References = new[] { fixtureAssembly } });
        Assert.Empty(result.Diagnostics);
        Assert.Equal(18, result.Value);
    }

    [Fact]
    public void ImportedReservedNamespaceAndTypes_ResolveCanonicalMetadataNames()
    {
        string fixtureAssembly = typeof(@class.@type).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader.RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray();
        string rendered = Render(
            """
            using @class;

            public static class Holder
            {
                public static int Run() => new @type().Value + new type_().Value;
            }
            """,
            references);

        Assert.Contains("import class__", rendered, StringComparison.Ordinal);
        Assert.Contains("type__()", rendered, StringComparison.Ordinal);
        Assert.Contains("type_()", rendered, StringComparison.Ordinal);

        using var resolver = ReferenceResolver.WithReferences(new[] { fixtureAssembly });
        TranslationTestValidation.AssertBinds(resolver, rendered);
        var result = EmittedOracle.Evaluate(
            new[] { rendered + Environment.NewLine + "Holder.Run()" },
            new EmittedOracleOptions { References = new[] { fixtureAssembly } });
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void BareIndexContextualNames_AreAllocated()
    {
        string rendered = Render(
            """
            public static class Holder
            {
                public static int Read(int[] @stackalloc, int[] @base)
                {
                    return @stackalloc[0] + @base[0];
                }
            }
            """);

        Assert.Contains("Read(stackalloc_ []int32, base_ []int32)", rendered, StringComparison.Ordinal);
        Assert.Contains("stackalloc_[0]", rendered, StringComparison.Ordinal);
        Assert.Contains("base_[0]", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void LegalPublicSuffixedNames_RemainUnchanged()
    {
        string rendered = Render(
            """
            namespace type_;

            public class type_ { }

            public class Holder
            {
                public int type_;

                public type_ Echo(type_ type_)
                {
                    this.type_ = 1;
                    return type_;
                }
            }
            """);

        Assert.Contains("package type_", rendered, StringComparison.Ordinal);
        Assert.Contains("class type_ {", rendered, StringComparison.Ordinal);
        Assert.Contains("var type_ int32", rendered, StringComparison.Ordinal);
        Assert.Contains("Echo(type_ type_) type_", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("type__", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void TypeContextualNames_AreAllocatedInTypeClausesAndConstruction()
    {
        string rendered = Render(
            """
            public class @event { }
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
            }
            """);

        foreach ((string method, string name) in new[]
                 {
                     ("Event", "event_"),
                     ("Prop", "prop_"),
                     ("Init", "init_"),
                     ("Convenience", "convenience_"),
                     ("Shared", "shared_"),
                     ("Delegate", "delegate_"),
                     ("Unmanaged", "unmanaged_"),
                 })
        {
            Assert.Contains($"class {name}", rendered, StringComparison.Ordinal);
            Assert.Contains($"func {method}() {name} -> {name}()", rendered, StringComparison.Ordinal);
        }

        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void PatternContextualNames_DeclarationAndReferencesBind()
    {
        string rendered = Render(
            """
            public static class Holder
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
            }
            """);

        Assert.Contains("int32 when_", rendered, StringComparison.Ordinal);
        Assert.Contains("int32 and_", rendered, StringComparison.Ordinal);
        Assert.Contains("int32 or_", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void UnicodeEscapedIdentifiers_UseValueTextAndBind()
    {
        string rendered = Render(
            """
            public class cl\u0061ss
            {
                public int p\u0061rams;

                public int Read(int p\u0061rams)
                {
                    int ordin\u0061ry = p\u0061rams;
                    this.p\u0061rams = ordin\u0061ry;
                    return this.p\u0061rams;
                }
            }
            """);

        Assert.Contains("class class_", rendered, StringComparison.Ordinal);
        Assert.Contains("var params int32", rendered, StringComparison.Ordinal);
        Assert.Contains("Read(params_ int32)", rendered, StringComparison.Ordinal);
        Assert.Contains("let ordinary", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(@"\u", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void NameofReservedParameter_PreservesSourceStringAtRuntime()
    {
        string rendered = Render(
            """
            public static class Holder
            {
                public static string Read(int @params) => nameof(@params);
            }
            """);

        Assert.Contains("Read(params_ int32)", rendered, StringComparison.Ordinal);
        Assert.Contains("\"params\"", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("nameof(", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Holder.Read(1)");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("params", result.Value);
    }

    [Fact]
    public void SourceNamespaceSegments_AliasesAndQualifiedReferencesBind()
    {
        IReadOnlyDictionary<string, string> rendered = RenderFiles(
            ("Producer.cs", """
                namespace @class;

                public class Widget { }
                """),
            ("Consumer.cs", """
                using @import = @class.Widget;

                namespace Consumer;

                public class Holder
                {
                    public @class.Widget Direct() => new @class.Widget();

                    public @import Aliased() => new @import();
                }
                """));

        Assert.Contains("package class_", rendered["Producer.cs"], StringComparison.Ordinal);
        Assert.Contains(
            "import import_ = class_.Widget",
            rendered["Consumer.cs"],
            StringComparison.Ordinal);
        Assert.DoesNotContain("@class", rendered["Consumer.cs"], StringComparison.Ordinal);
        Assert.DoesNotContain("@import", rendered["Consumer.cs"], StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered.Values.ToArray());
    }

    [Fact]
    public void ImportedAttributeNamedArguments_UseAllocatedNames()
    {
        string fixtureAssembly = typeof(ReservedNamedAttribute).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader.RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixtureAssembly))
            .ToArray();
        string rendered = Render(
            """
            using Cs2Gs.Tests;

            [ReservedNamed("a", "b", @type = "c", type_ = "d")]
            public class Holder { }
            """,
            references);

        Assert.Contains(
            "@ReservedNamed(\"a\", \"b\", type__: \"c\", type_: \"d\")",
            rendered,
            StringComparison.Ordinal);
        using var resolver = ReferenceResolver.WithReferences(new[] { fixtureAssembly });
        TranslationTestValidation.AssertBinds(resolver, rendered);
    }

    [Fact]
    public void EscapedReservedSourceAttributeName_DeclarationAndUseBind()
    {
        string rendered = Render(
            """
            using System;

            public sealed class @class : Attribute
            {
                public @class(string value) { }
            }

            [@class("ok")]
            public sealed class Holder { }
            """);

        Assert.Contains("class class_", rendered, StringComparison.Ordinal);
        Assert.Contains("@class_(\"ok\")", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    private static void AssertNoStandaloneIdentifier(string rendered, string identifier)
    {
        Match match = Regex.Match(
            rendered,
            $@"(?<![A-Za-z0-9_]){Regex.Escape(identifier)}(?![A-Za-z0-9_])");
        Assert.False(match.Success, $"raw identifier '{identifier}' leaked into translated G#:\n{rendered}");
    }

    private static string Render(
        string source,
        IReadOnlyList<MetadataReference> references = null)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Issue3461.cs", source) },
            references);

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    private static IReadOnlyDictionary<string, string> RenderFiles(
        params (string FileName, string Source)[] sources)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources);
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator();
        return project.Documents.ToDictionary(
            document => document.FilePath,
            document =>
            {
                var context = new TranslationContext(
                    project.Compilation,
                    document.SemanticModel,
                    document.FilePath);
                return GSharpPrinter.Print(translator.TranslateDocument(document, context));
            },
            StringComparer.Ordinal);
    }
}

/// <summary>Imported attribute fixture with reserved and colliding CLR names.</summary>
public sealed class ReservedNamedAttribute : Attribute
{
    /// <summary>Initializes a new instance.</summary>
    public ReservedNamedAttribute(string @params, string params_)
    {
    }

    /// <summary>Gets or sets reserved-name data.</summary>
    public string @type { get; set; }

    /// <summary>Gets or sets colliding legal-name data.</summary>
    public string type_ { get; set; }
}

/// <summary>Imported CLR field fixture with colliding names.</summary>
public sealed class ImportedIdentifierFields
{
    /// <summary>Reserved-name field.</summary>
    public int @type = 3;

    /// <summary>Legal colliding field.</summary>
    public int type_ = 5;
}

/// <summary>Imported CLR property fixture with colliding names.</summary>
public sealed class ImportedIdentifierProperties
{
    /// <summary>Reserved-name property.</summary>
    public int @type => 7;

    /// <summary>Legal colliding property.</summary>
    public int type_ => 11;
}

/// <summary>Imported CLR method fixture with colliding and contextual names.</summary>
public sealed class ImportedIdentifierMethods
{
    /// <summary>Reserved-name method.</summary>
    public int @type() => 13;

    /// <summary>Legal colliding method.</summary>
    public int type_() => 15;

    /// <summary>Contextual method name legal after member access.</summary>
    public int @make() => 0;
}

/// <summary>Imported static contextual method fixture.</summary>
public static class ImportedContextualStatics
{
    /// <summary>Returns one.</summary>
    public static int @nameof() => 1;

    /// <summary>Returns two.</summary>
    public static int @typeof() => 2;

    /// <summary>Returns four.</summary>
    public static int @sizeof() => 4;

    /// <summary>Returns eight.</summary>
    public static int @checked() => 8;

    /// <summary>Returns sixteen.</summary>
    public static int @unchecked() => 16;

    /// <summary>Returns generic value.</summary>
    public static T @base<T>(T value) => value;

    /// <summary>Returns generic value.</summary>
    public static T @stackalloc<T>(T value) => value;

    /// <summary>Returns generic value.</summary>
    public static T @nameof<T>(T value) => value;
}

/// <summary>Imported contextual static field fixture.</summary>
public static class ImportedContextualStaticFields
{
    /// <summary>Reserved index-prefix field.</summary>
    public static readonly int[] @base = { 3 };

    /// <summary>Reserved index-prefix field.</summary>
    public static readonly int[] @stackalloc = { 5 };

    /// <summary>Reserved invocation field.</summary>
    public static readonly Func<int> @nameof = () => 7;
}

/// <summary>Imported contextual static property fixture.</summary>
public static class ImportedContextualStaticProperties
{
    /// <summary>Reserved index-prefix property.</summary>
    public static int[] @base { get; } = new[] { 4 };

    /// <summary>Reserved index-prefix property.</summary>
    public static int[] @stackalloc { get; } = new[] { 6 };

    /// <summary>Reserved invocation property.</summary>
    public static Func<int> @nameof { get; } = () => 8;
}
