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
