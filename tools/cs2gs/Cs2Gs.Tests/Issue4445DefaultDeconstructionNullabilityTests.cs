// <copyright file="Issue4445DefaultDeconstructionNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4445: inferred locals initialized from <c>default(T)</c> carry
/// Roslyn's maybe-null state into G#, including tuple and nested deconstruction.
/// </summary>
public class Issue4445DefaultDeconstructionNullabilityTests
{
    private const string Source = """
        #nullable enable

        public static class Defaults
        {
            private static void Fill<T>(ref T? value, T replacement) => value = replacement;

            private static (string Text, System.Collections.Generic.List<string> Values) BuildPair() =>
                ("pair", new System.Collections.Generic.List<string>());

            private static (T? Left, T? Right) NullablePair<T>() =>
                (default, default);

            private static int Unconstrained<T>(T replacement, bool choose)
            {
                var direct = default(T);
                var alias = direct;
                var branch = choose ? default(T) : alias;
                var (a, _) = (default(T), 0);
                (var b, var c) = (default(T), default(T));
                var ((d, e), f) = ((default(T), default(T)), default(T));
                (var (nestedA, nestedB), var nestedC) =
                    ((default(T), default(T)), default(T));
                var (wholeLeft, wholeRight) = default((T, T));
                var ((wholeNestedA, wholeNestedB), wholeNestedC) =
                    default(((T, T), T));
                var (methodLeft, methodRight) = NullablePair<T>();

                Fill(ref direct, replacement);
                Fill(ref alias, replacement);
                Fill(ref branch, replacement);
                Fill(ref a, replacement);
                Fill(ref b, replacement);
                Fill(ref c, replacement);
                Fill(ref d, replacement);
                Fill(ref e, replacement);
                Fill(ref f, replacement);
                Fill(ref nestedA, replacement);
                Fill(ref nestedB, replacement);
                Fill(ref nestedC, replacement);
                Fill(ref wholeLeft, replacement);
                Fill(ref wholeRight, replacement);
                Fill(ref wholeNestedA, replacement);
                Fill(ref wholeNestedB, replacement);
                Fill(ref wholeNestedC, replacement);
                Fill(ref methodLeft, replacement);
                Fill(ref methodRight, replacement);

                for (var loop = default(T); choose;)
                {
                    Fill(ref loop, replacement);
                    break;
                }

                for (var (loopLeft, loopRight) = (default(T), default(T)); choose;)
                {
                    Fill(ref loopLeft, replacement);
                    Fill(ref loopRight, replacement);
                    break;
                }

                return 8;
            }

            private static int ClassConstrained<T>(T replacement)
                where T : class
            {
                T? maybe = replacement;
                if (maybe is null)
                {
                    throw new System.Exception();
                }
                var narrowed = maybe;
                var (narrowedLeft, narrowedRight) = (maybe, maybe);
                var coalesced = default(T) ?? default(T);
                var coalesceNarrowed = default(T) ?? replacement;
                var (left, right) = (default(T), default(T));
                Fill(ref coalesced, replacement);
                Fill(ref left, replacement);
                Fill(ref right, replacement);
                return 2;
            }

            private static int ValueTypeControl()
            {
                var directValue = default(int);
                var (leftValue, rightValue) = (default(int), default(int));
                return directValue + leftValue + rightValue + 3;
            }

            private static (T Left, T Right) Next<T>(ref int count, T replacement)
            {
                count++;
                return (replacement, replacement);
            }

            private static int IncrementorControl<T>(T replacement)
            {
                T? left = default;
                T? right = default;
                var count = 0;
                for (; count < 3; (left, right) = Next(ref count, replacement))
                {
                    if (count < 2)
                    {
                        continue;
                    }
                }

                return count + (left is null ? 0 : 1) + (right is null ? 0 : 1);
            }

            private static async System.Threading.Tasks.Task<T> AwaitControl<T>(
                System.Func<System.Threading.Tasks.Task<T>> body)
            {
                var result = await body().ConfigureAwait(false);
                return result;
            }

            private static int Controls<T>(T replacement)
            {
                var suppressed = default(T)!;
                var ordinary = "text";
                T explicitLocal = default(T);
                T? annotated = default(T);
                (T explicitLeft, T explicitRight) = (default(T), default(T));
                var (ordinaryLeft, ordinaryRight) = ("left", "right");
                var (callText, callValues) = BuildPair();
                var lambda = (int value = 1) => value;
                return ordinary.Length + ordinaryLeft.Length + ordinaryRight.Length
                    + callText.Length + callValues.Count + lambda();
            }

            public static int Run() =>
                Unconstrained<string>("u", true)
                + ClassConstrained<string>("c")
                + ValueTypeControl()
                + IncrementorControl<string>("i");
        }
        """;

    [Fact]
    public void RoslynContracts_DefaultGenericLocalsAreAnnotatedAndMaybeNull()
    {
        LoadedCSharpProject project = Load();
        LoadedDocument document = Assert.Single(project.Documents);
        SemanticModel model = document.SemanticModel;
        SyntaxNode root = document.SyntaxTree.GetRoot();

        ILocalSymbol direct = Local(root, model, "direct");
        ILocalSymbol tupleLeaf = Local(root, model, "a");
        ILocalSymbol classLeaf = Local(root, model, "left");
        ILocalSymbol valueLeaf = Local(root, model, "leftValue");
        ILocalSymbol narrowed = Local(root, model, "narrowed");
        ILocalSymbol narrowedLeaf = Local(root, model, "narrowedLeft");
        VariableDeclaratorSyntax suppressedSyntax = root.DescendantNodes()
            .OfType<VariableDeclaratorSyntax>()
            .Single(node => node.Identifier.ValueText == "suppressed");
        VariableDeclaratorSyntax narrowedSyntax = root.DescendantNodes()
            .OfType<VariableDeclaratorSyntax>()
            .Single(node => node.Identifier.ValueText == "narrowed");

        Assert.Equal(NullableAnnotation.Annotated, direct.NullableAnnotation);
        Assert.Equal(NullableFlowState.MaybeNull, model.GetTypeInfo(
            root.DescendantNodes().OfType<VariableDeclaratorSyntax>()
                .Single(node => node.Identifier.ValueText == "direct")
                .Initializer.Value).Nullability.FlowState);
        Assert.Equal(NullableAnnotation.Annotated, tupleLeaf.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, classLeaf.NullableAnnotation);
        Assert.Equal(NullableAnnotation.NotAnnotated, valueLeaf.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, narrowed.NullableAnnotation);
        Assert.Equal(NullableAnnotation.Annotated, narrowedLeaf.NullableAnnotation);
        Assert.Equal(
            NullableFlowState.NotNull,
            model.GetTypeInfo(narrowedSyntax.Initializer.Value).Nullability.FlowState);
        TupleExpressionSyntax narrowedTuple = root.DescendantNodes()
            .OfType<TupleExpressionSyntax>()
            .Single(tuple => tuple.ToString() == "(maybe, maybe)");
        Assert.Equal(
            NullableFlowState.NotNull,
            model.GetSpeculativeTypeInfo(
                narrowedTuple.Arguments[0].Expression.SpanStart,
                narrowedTuple.Arguments[0].Expression,
                SpeculativeBindingOption.BindAsExpression).Nullability.FlowState);
        Assert.Equal(
            NullableFlowState.NotNull,
            model.GetTypeInfo(suppressedSyntax.Initializer.Value).Nullability.FlowState);
    }

    [Fact]
    public void Translation_CarriesMaybeNullStorageThroughEveryLocalShape()
    {
        string printed = Translate();

        foreach (string name in new[]
        {
            "direct", "alias", "branch", "a", "b", "c", "d", "e", "f", "loop",
            "nestedA", "nestedB", "nestedC", "wholeLeft", "wholeRight",
            "wholeNestedA", "wholeNestedB", "wholeNestedC",
            "loopLeft", "loopRight", "coalesced", "left", "right",
        })
        {
            Assert.Matches($@"\b(let|var) {name} T\? =", printed);
        }

        Assert.DoesNotMatch(@"\b(let|var) (directValue|leftValue|rightValue) int32\? =", printed);
        Assert.DoesNotContain("suppressed T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ordinary string? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ordinaryLeft string? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ordinaryRight string? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("callText string? =", printed, StringComparison.Ordinal);
        Assert.DoesNotMatch(@"\b(let|var) callValues [^=\r\n]*\? =", printed);
        Assert.DoesNotContain("explicitLocal T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("explicitLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("explicitRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("narrowed T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("narrowedLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("narrowedRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("coalesceNarrowed T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("methodLeft T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("methodRight T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("result T? =", printed, StringComparison.Ordinal);
        Assert.DoesNotMatch(@"\b(let|var) lambda [^=\r\n]*\? =", printed);
        Assert.Contains("suppressed = default(T)!!", printed, StringComparison.Ordinal);
        Assert.Contains("annotated T? = default(T)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let _ =", printed, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Defaults.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0612");
        Assert.Null(result.UnhandledException);
        Assert.Equal(18, result.Value);
    }

    private static ILocalSymbol Local(SyntaxNode root, SemanticModel model, string name)
    {
        SyntaxNode declaration = root.DescendantNodes()
            .First(node => node switch
            {
                VariableDeclaratorSyntax declarator => declarator.Identifier.ValueText == name,
                SingleVariableDesignationSyntax designation => designation.Identifier.ValueText == name,
                _ => false,
            });
        return Assert.IsAssignableFrom<ILocalSymbol>(model.GetDeclaredSymbol(declaration));
    }

    private static string Translate()
    {
        LoadedCSharpProject project = Load();
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        return printed;
    }

    private static LoadedCSharpProject Load()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", Source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }
}
