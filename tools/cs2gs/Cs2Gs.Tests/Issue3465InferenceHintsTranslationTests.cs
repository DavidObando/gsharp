// <copyright file="Issue3465InferenceHintsTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue3465InferenceHintsTranslationTests
{
    [Fact]
    public void InterfaceBasedInference_EmitsHintsForStaticInstanceAndExtensionCalls()
    {
        string rendered = Render("""
            using System.Collections.Generic;
            using Metadata = System.Reflection.Metadata;

            public sealed class InferenceProbe
            {
                public static bool StaticEqual<T>(
                    IEnumerable<T> left,
                    IEnumerable<T> right)
                    where T : struct
                {
                    using var leftEnumerator = left.GetEnumerator();
                    using var rightEnumerator = right.GetEnumerator();
                    while (true)
                    {
                        var hasLeft = leftEnumerator.MoveNext();
                        var hasRight = rightEnumerator.MoveNext();
                        if (hasLeft != hasRight)
                        {
                            return false;
                        }

                        if (!hasLeft)
                        {
                            return true;
                        }
                    }
                }

                public bool InstanceEqual<T>(
                    IEnumerable<T> left,
                    IEnumerable<T> right)
                    where T : struct =>
                    StaticEqual(left, right);

                public static bool Select<T>(
                    IEnumerable<T> left,
                    IEnumerable<T> right)
                    where T : struct =>
                    StaticEqual(left, right);

                public static bool Select<T>(
                    IEnumerable<T> left,
                    IEnumerable<T> right,
                    bool fallback)
                    where T : struct =>
                    fallback;

                public static bool Compare(
                    Metadata.TypeDefinition left,
                    Metadata.TypeDefinition right)
                {
                    var probe = new InferenceProbe();
                    return StaticEqual(left.GetFields(), right.GetFields())
                        && probe.InstanceEqual(left.GetFields(), right.GetFields())
                        && left.GetFields().SequenceEqual(right.GetFields())
                        && Select(left.GetFields(), right.GetFields());
                }
            }

            public static class InferenceExtensions
            {
                public static bool SequenceEqual<T>(
                    this Metadata.FieldDefinitionHandleCollection left,
                    IEnumerable<T> right)
                    where T : struct
                {
                    return true;
                }
            }
            """);

        Assert.Contains(
            "StaticEqual[FieldDefinitionHandle](left.GetFields(), right.GetFields())",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains(
            "probe.InstanceEqual[FieldDefinitionHandle](left.GetFields(), right.GetFields())",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains(
            "left.GetFields().SequenceEqual[FieldDefinitionHandle](right.GetFields())",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains(
            "Select[FieldDefinitionHandle](left.GetFields(), right.GetFields())",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains("import System.Reflection.Metadata", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void DirectInferenceStaysImplicit_ExplicitArgumentsAndOverloadsStayExact()
    {
        string rendered = Render("""
            public static class GenericPolicyProbe
            {
                private static T Identity<T>(T value)
                    where T : struct =>
                    value;

                private static int Choose<T>(T value)
                    where T : struct =>
                    1;

                private static int Choose<T>(T first, T second)
                    where T : struct =>
                    2;

                public static int Run() =>
                    (Identity(7) * 100)
                    + (Identity<int>(8) * 10)
                    + Choose(1)
                    + Choose<int>(2, 3);
            }
            """);

        Assert.Contains("Identity(7)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Identity[int32](7)", rendered, StringComparison.Ordinal);
        Assert.Contains("Identity[int32](8)", rendered, StringComparison.Ordinal);
        Assert.Contains("Choose(1)", rendered, StringComparison.Ordinal);
        Assert.Contains("Choose[int32](2, 3)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "GenericPolicyProbe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(783, result.Value);
    }

    [Fact]
    public void VoidBlockLambda_UsesKnownDelegateReturn_ValueBlockLambdaStaysArrow()
    {
        string rendered = Render("""
            using System;
            using System.Collections.Generic;
            using System.Reflection.Emit;

            public sealed class LambdaProbe
            {
                private readonly HashSet<int> seen = new();

                private static void Visit(Action<OperandType, int> visitor) =>
                    visitor(OperandType.InlineI, 4);

                private static void Visit(Func<OperandType, int, bool> visitor) =>
                    throw new InvalidOperationException();

                private static void VisitOne(Action<int> visitor) =>
                    visitor(6);

                private static int Produce(Func<int> producer) => producer();

                public int Run()
                {
                    Visit((operandType, token) =>
                    {
                        if (operandType != OperandType.InlineI)
                        {
                            return;
                        }

                        seen.Add(token);
                    });
                    VisitOne(value => seen.Add(value));

                    var produced = Produce(() =>
                    {
                        return 5;
                    });
                    return (seen.Count * 10) + produced;
                }
            }
            """);

        Assert.Contains(
            "func (operandType OperandType, token int32) {",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains("VisitOne(func (value int32) {", rendered, StringComparison.Ordinal);
        Assert.Contains("Produce(() -> {", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "LambdaProbe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(25, result.Value);
    }

    [Fact]
    public void GenericDelegateInference_PreservesMethodGroupsAndNestedDelegateTargets()
    {
        string rendered = Render("""
            using System;
            using System.Collections.Generic;

            public delegate void NestedVisitor(int value);

            public sealed class DelegateProbe
            {
                private readonly HashSet<int> seen = new();

                private static TResult Invoke<TResult>(Func<TResult> factory) =>
                    factory();

                private static void Accept(Func<NestedVisitor> factory) =>
                    factory()(3);

                private static int MethodGroupValue() => 7;

                public int Run()
                {
                    Accept(() => value =>
                    {
                        seen.Add(value);
                    });

                    var fromMethodGroup = Invoke(MethodGroupValue);
                    var fromExpression = Invoke(() => 5);
                    var fromBlock = Invoke(() =>
                    {
                        return 6;
                    });
                    return (seen.Count * 100)
                        + (fromMethodGroup * 10)
                        + fromExpression
                        + fromBlock;
                }
            }
            """);

        Assert.Contains("func (value int32) {", rendered, StringComparison.Ordinal);
        Assert.Contains("Invoke(MethodGroupValue)", rendered, StringComparison.Ordinal);
        Assert.Contains("Invoke(() -> 5)", rendered, StringComparison.Ordinal);
        Assert.Contains("Invoke(() -> {", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "DelegateProbe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(181, result.Value);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Issue3465.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit =
            new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
