// <copyright file="Issue3501ResidualSyntheticRetargetTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 residual-synthetic burn-down: <c>goto default</c> to a
/// do-nothing arm prints as a native <c>break</c> (no <c>__gotoDefault</c>
/// label pair), and an implicit C# <c>in</c> argument to a source-declared
/// method gains the modifier G# requires (GS0242 is an error).
/// </summary>
public class Issue3501ResidualSyntheticRetargetTests
{
    [Fact]
    public void GotoDefault_ToEmptyBreakArm_PrintsAsBreak()
    {
        string printed = Translate("""
            public class C
            {
                public static int Route(int value, bool bail)
                {
                    switch (value)
                    {
                        case 1:
                            if (bail)
                            {
                                goto default;
                            }

                            return 10;
                        case 2:
                            return 20;
                        default:
                            break;
                    }

                    return -1;
                }
            }
            """);

        Assert.DoesNotContain("__gotoDefault", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("goto ", printed, StringComparison.Ordinal);
        Assert.Contains("break", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void GotoDefault_InsideLoop_KeepsTheLabelLowering()
    {
        // A bare `break` in the goto's position would exit the inner loop,
        // not the switch, so the synthesized label pair stays.
        string printed = Translate("""
            public class C
            {
                public static int Route(int value)
                {
                    switch (value)
                    {
                        case 1:
                            for (int i = 0; i < 3; i++)
                            {
                                goto default;
                            }

                            return 10;
                        default:
                            break;
                    }

                    return -1;
                }
            }
            """);

        Assert.Contains("__gotoDefault", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ImplicitInArgument_ToSourceDeclaredMethod_GainsTheModifier()
    {
        string printed = Translate("""
            public class C
            {
                private static int Scale(in int factor) => factor * 2;

                public static int Run()
                {
                    int x = 3;
                    return Scale(x);
                }
            }
            """);

        Assert.Contains("Scale(in x)", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void ParamsArrayNullGuard_FoldsAway()
    {
        // C# guards `params object?[]` against an explicit null argument; a
        // G# variadic always materializes an array, so gsc rejects the
        // always-true compare (GS0523, the Diagnostic.Create self-migration
        // blocker). The test folds and the `&&` absorbs the constant.
        string printed = Translate("""
            public class C
            {
                public static string Render(string format, params object?[] args)
                {
                    return args != null && args.Length > 0
                        ? string.Format(format, args)
                        : format;
                }
            }
            """);

        Assert.DoesNotContain("!= nil", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("true &&", printed, StringComparison.Ordinal);
        Assert.Contains(".Length > 0", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void ParamsArrayPropertyPattern_SkipsTheNilGuard()
    {
        // `args is { Length: > 0 }` guards a C# params array that a G#
        // variadic can never leave nil — gsc rejects the defensive guard
        // (GS0523), so only the member test survives.
        string printed = Translate("""
            public class C
            {
                public static string Render(string format, params object?[] args)
                {
                    return args is { Length: > 0 }
                        ? string.Format(format, args)
                        : format;
                }
            }
            """);

        Assert.DoesNotContain("!= nil", printed, StringComparison.Ordinal);
        Assert.Contains(".Length > 0", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void SiblingLocalFunctionDependency_HoistsCalleeFirst()
    {
        // `Scan` calls its sibling `Deep`; the hoist must order `Deep`'s
        // `let` before `Scan`'s or the reference fails lexically (GS0130 —
        // the MemberLookup.IsErasureOnlyEnumMatch self-migration blocker).
        string printed = Translate("""
            public class C
            {
                public static bool Outer(int value)
                {
                    return Scan(value);

                    static bool Scan(int v)
                    {
                        for (int i = 0; i < v; i++)
                        {
                            if (Deep(i))
                            {
                                return true;
                            }
                        }

                        return false;
                    }

                    static bool Deep(int n)
                    {
                        if (n > 4)
                        {
                            return Deep(n - 5);
                        }

                        return n == 3;
                    }
                }
            }
            """);

        int deepIndex = printed.IndexOf("let Deep", StringComparison.Ordinal);
        int scanIndex = printed.IndexOf("let Scan", StringComparison.Ordinal);
        Assert.True(deepIndex >= 0 && scanIndex >= 0, printed);
        Assert.True(deepIndex < scanIndex, printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void GuardedNullableArrayElement_KeepsTheUserSuppression()
    {
        // C# flow proves `items[i]` non-null inside the guard, but G# never
        // narrows an indexed read — dropping the user's `!` produced GS0154
        // (the OverloadResolver.Constructors self-migration blocker).
        string printed = Translate("""
            #nullable enable
            public class Node
            {
                public string Render() => "n";
            }

            public class C
            {
                private static Node Unwrap(Node value) => value;

                public static string Run(Node?[] items, int i)
                {
                    var chosen = i < items.Length && items[i] != null
                        ? Unwrap(items[i]!)
                        : null;
                    return chosen?.Render() ?? "none";
                }
            }
            """);

        Assert.Contains("Unwrap(items[i]!!)", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void ObjectTypedMemberConstantPattern_KeepsTheIsForm()
    {
        // `token.Value is true` over `object?` has no `==` in G# (GS0129, the
        // OverloadResolver.Candidates self-migration blocker); the constant
        // pattern binds over object natively, so the `is` form stays.
        string printed = Translate("""
            #nullable enable
            public class Token
            {
                public object? Value { get; init; }
            }

            public class C
            {
                public static bool IsLiteralTrue(object condition) =>
                    condition is Token { Value: true };
            }
            """);

        Assert.Contains("is true", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("== true", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void InferredGenericOverload_WithUserTypeArguments_SpellsThemExplicitly()
    {
        // GS0155: gsc's erased inference collapses FieldSymbol to object,
        // letting the invariant non-generic AddRange sibling win and fail
        // conversion. The C#-chosen generic overload keeps its inferred
        // user-type arguments explicitly.
        string printed = Translate("""
            using System.Collections.Immutable;

            public class Symbol { }
            public sealed class FieldSymbol : Symbol { }

            public static class C
            {
                public static ImmutableArray<Symbol> Collect(ImmutableArray<FieldSymbol> fields)
                {
                    var builder = ImmutableArray.CreateBuilder<Symbol>();
                    builder.AddRange(fields);
                    return builder.ToImmutable();
                }
            }
            """);

        Assert.Contains("builder.AddRange[FieldSymbol](fields)", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void DocComments_SanitizedParamNames_AndDocAdjacency()
    {
        // GS0229: the @param spelling follows the parameter's EMITTED name
        // (keyword collisions gain the underscore); an extension receiver's
        // @param is dropped. GS0227: a regular comment between the doc block
        // and its declaration detaches it in G#, so docs print last.
        string printed = Translate("""
            public class Widget
            {
                /// <summary>Renders a widget.</summary>
                /// <param name="package">The declaring package.</param>
                /// <param name="count">The repeat count.</param>
                // Regular note that used to wedge between doc and decl.
                public string Render(string package, int count) => package + count;
            }

            public static class WidgetExtensions
            {
                /// <summary>Describes the widget.</summary>
                /// <param name="widget">The receiver.</param>
                /// <param name="suffix">The suffix.</param>
                public static string Describe(this Widget widget, string suffix) =>
                    widget.Render("p", 1) + suffix;
            }
            """);

        Assert.Contains("@param package_ The declaring package.", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("@param package ", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("@param widget", printed, StringComparison.Ordinal);
        Assert.Contains("@param suffix", printed, StringComparison.Ordinal);

        int note = printed.IndexOf("// Regular note", StringComparison.Ordinal);
        int doc = printed.IndexOf("/// Renders a widget.", StringComparison.Ordinal);
        Assert.True(note >= 0 && doc >= 0 && note < doc, printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void StaticConstructorDoc_DowngradesToRegularComment()
    {
        // A G# static `init` block is not a documentable declaration; the C#
        // static constructor's doc comment becomes a regular comment instead
        // of a detached `///` block (GS0227).
        string printed = Translate("""
            public class Registry
            {
                /// <summary>Static-initializer hook.</summary>
                static Registry()
                {
                    Count = 1;
                }

                public static int Count { get; set; }
            }
            """);

        Assert.Contains("// Static-initializer hook.", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("/// Static-initializer hook.", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void LongConstructorHeader_WrapsItsParameterList()
    {
        // Issue #3501: `init`/`convenience init` headers were the dominant
        // string-free >300-char lines; over-budget headers wrap after `(`
        // and each comma, the same continuation the func renderer emits.
        string printed = Translate("""
            public sealed class WideNode
            {
                public WideNode(
                    string firstComponentIdentifier,
                    string secondComponentIdentifier,
                    string thirdComponentIdentifier,
                    string fourthComponentIdentifier,
                    string fifthComponentIdentifier,
                    string sixthComponentIdentifier,
                    string seventhComponentIdentifier)
                {
                    Summary = firstComponentIdentifier + secondComponentIdentifier + thirdComponentIdentifier
                        + fourthComponentIdentifier + fifthComponentIdentifier + sixthComponentIdentifier
                        + seventhComponentIdentifier;
                }

                public string Summary { get; }
            }
            """);

        Assert.Contains("init(\n", printed.Replace("\r", string.Empty), StringComparison.Ordinal);
        foreach (string line in printed.Split('\n'))
        {
            Assert.True(line.Length <= 300, "over-300 line: " + line);
        }

        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void LongObjectCreationWithInitializer_Wraps()
    {
        // A construction WITH an object initializer escaped every wrap rule
        // (the SideEffectSpiller/ExpressionTreeLowerer BoundProgram returns —
        // the last string-free >300-char statement family).
        string printed = Translate("""
            public sealed class ProgramInfo
            {
                public ProgramInfo(string entryPointPackage, string packages, string diagnostics, string functions, string entryPoint, string statement, string structs, string interfaces, string enums, string delegates) { }

                public string EntryPointPackage { get; } = "";
                public string Packages { get; } = "";
                public string Diagnostics { get; } = "";
                public string EntryPoint { get; } = "";
                public string Statement { get; } = "";
                public string Structs { get; } = "";
                public string Interfaces { get; } = "";
                public string Enums { get; } = "";
                public string Delegates { get; } = "";
                public string Imports { get; init; } = "";
                public string FriendAssemblies { get; init; } = "";
            }

            public static class Rewriter
            {
                public static ProgramInfo Clone(ProgramInfo program, string functions)
                {
                    return new ProgramInfo(program.EntryPointPackage, program.Packages, program.Diagnostics, functions, program.EntryPoint, program.Statement, program.Structs, program.Interfaces, program.Enums, program.Delegates)
                    {
                        Imports = program.Imports,
                        FriendAssemblies = program.FriendAssemblies,
                    };
                }
            }
            """);

        foreach (string line in printed.Split('\n'))
        {
            Assert.True(line.Length <= 300, "over-300 line: " + line);
        }

        Assert.Contains("Imports = program.Imports,", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void MultilineStringLiterals_KeepTheirLineStructure()
    {
        // A C# raw/verbatim multiline literal previously collapsed into an
        // escaped one-liner — the source of most >300-char emitted lines.
        // It now renders as a Go-style backtick raw string with the original
        // line breaks; values embedding a backtick keep the escaped form.
        string printed = Translate("""""
            public static class Fixtures
            {
                public const string Source = """
                    import System

                    func Marker() int32 { return 401 }

                    Console.WriteLine(Marker())
                    """;

                public const string WithBacktick = "a`b\nc";
            }
            """"");

        Assert.Contains("`import System", printed.Replace("\r", string.Empty), StringComparison.Ordinal);
        Assert.Contains("func Marker() int32 { return 401 }", printed, StringComparison.Ordinal);
        Assert.Contains("\"a`b\\nc\"", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void MultilineInterpolatedRawString_LowersToBacktickConcat()
    {
        // C# raw strings can carry interpolation holes; G# backtick raws are
        // fully literal. A multiline interpolated raw lowers to a
        // concatenation of backtick segments and hole values (non-string
        // holes gain ToString), preserving the author's line structure.
        string printed = Translate("""""
            public static class Fixtures
            {
                public static string Build(string name, int count)
                {
                    return $"""
                        header for {name}
                        body line one
                        count is {count}
                        trailer
                        """;
                }

                public static string Formatted(double ratio)
                {
                    return $"""
                        first {ratio:0.00}
                        second
                        third
                        """;
                }
            }
            """"");

        string normalized = printed.Replace("\r", string.Empty);
        Assert.Contains("\"header for \" + name + `\nbody line one\ncount is ` + count.ToString() + `\ntrailer`", normalized, StringComparison.Ordinal);

        // A hole with a format clause keeps the classic interpolated form.
        Assert.Contains("${ratio", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void DualDictionaryFixture_DroppedMember_DoesNotCrashTheDocument()
    {
        // A dual IDictionary<int,int>/IReadOnlyDictionary<string,string>
        // implementer drops the second colliding explicit-interface property
        // (a reported gap); the null must not reach the member list — the
        // printer throws on it and the whole document (and every app linking
        // it) failed translate (the Core.Tests/Compiler.Tests/Interpreter.Tests
        // self-migration blocker).
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", """
                using System;
                using System.Collections;
                using System.Collections.Generic;

                public sealed class DualMapFixture : IDictionary<int, int>, IReadOnlyDictionary<string, string>
                {
                    string IReadOnlyDictionary<string, string>.this[string key] => throw new NotImplementedException();

                    int IDictionary<int, int>.this[int key]
                    {
                        get => throw new NotImplementedException();
                        set => throw new NotImplementedException();
                    }

                    ICollection<int> IDictionary<int, int>.Keys => throw new NotImplementedException();
                    ICollection<int> IDictionary<int, int>.Values => throw new NotImplementedException();
                    IEnumerable<string> IReadOnlyDictionary<string, string>.Keys => throw new NotImplementedException();
                    IEnumerable<string> IReadOnlyDictionary<string, string>.Values => throw new NotImplementedException();
                    int ICollection<KeyValuePair<int, int>>.Count => throw new NotImplementedException();
                    int IReadOnlyCollection<KeyValuePair<string, string>>.Count => throw new NotImplementedException();
                    bool ICollection<KeyValuePair<int, int>>.IsReadOnly => throw new NotImplementedException();
                    void IDictionary<int, int>.Add(int key, int value) => throw new NotImplementedException();
                    void ICollection<KeyValuePair<int, int>>.Add(KeyValuePair<int, int> item) => throw new NotImplementedException();
                    void ICollection<KeyValuePair<int, int>>.Clear() => throw new NotImplementedException();
                    bool ICollection<KeyValuePair<int, int>>.Contains(KeyValuePair<int, int> item) => throw new NotImplementedException();
                    bool IDictionary<int, int>.ContainsKey(int key) => throw new NotImplementedException();
                    bool IReadOnlyDictionary<string, string>.ContainsKey(string key) => throw new NotImplementedException();
                    void ICollection<KeyValuePair<int, int>>.CopyTo(KeyValuePair<int, int>[] array, int arrayIndex) => throw new NotImplementedException();
                    bool IDictionary<int, int>.Remove(int key) => throw new NotImplementedException();
                    bool ICollection<KeyValuePair<int, int>>.Remove(KeyValuePair<int, int> item) => throw new NotImplementedException();
                    bool IDictionary<int, int>.TryGetValue(int key, out int value) => throw new NotImplementedException();
                    bool IReadOnlyDictionary<string, string>.TryGetValue(string key, out string value) => throw new NotImplementedException();
                    IEnumerator<KeyValuePair<int, int>> IEnumerable<KeyValuePair<int, int>>.GetEnumerator() => throw new NotImplementedException();
                    IEnumerator<KeyValuePair<string, string>> IEnumerable<KeyValuePair<string, string>>.GetEnumerator() => throw new NotImplementedException();
                    IEnumerator IEnumerable.GetEnumerator() => throw new NotImplementedException();
                }
                """) });
        Assert.True(project.BoundWithoutErrors);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);

        // The drop itself is a reported gap; the assertion is only that the
        // print completes instead of throwing on a null member.
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains("DualMapFixture", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        return rendered;
    }
}
