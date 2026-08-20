// <copyright file="Issue3462DiscardAssignmentTranslationTests.cs" company="GSharp">
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

/// <summary>Issue #3462: statement-level discards remove only inert RHS values.</summary>
public sealed class Issue3462DiscardAssignmentTranslationTests
{
    [Fact]
    public void MethodBody_InertValuesAreRemoved_AndReservedParameterStaysSanitized()
    {
        string rendered = Render("""
            public static class Server
            {
                public static void Initialized(object @params)
                {
                    int local = 1;
                    _ = @params;
                    _ = local;
                    _ = 42;
                    _ = (local, @params);
                }
            }
            """);

        Assert.Contains("Initialized(params_ object)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("let _ =", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("\n        params_\n", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void MethodBody_EffectfulValuesUseNativeDiscard_AndRunInOrder()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int state;
                private int Value
                {
                    get
                    {
                        state = (state * 10) + 2;
                        return state;
                    }
                }

                private int this[int value]
                {
                    get
                    {
                        state = (state * 10) + value;
                        return state;
                    }
                }

                private int Touch(int value)
                {
                    state = (state * 10) + value;
                    return state;
                }

                public int Run()
                {
                    int local = 0;
                    _ = true ? Touch(9) : Touch(8);
                    _ = Touch(1);
                    _ = Value;
                    _ = this[3];
                    _ = local = 4;
                    _ = local++;
                    return (state * 10) + local;
                }
            }
            """);

        Assert.Contains("let _ = Touch(1)", rendered, StringComparison.Ordinal);
        Assert.Contains("let _ = if true { Touch(9) } else { Touch(8) }", rendered, StringComparison.Ordinal);
        Assert.Contains("let _ = Value", rendered, StringComparison.Ordinal);
        Assert.Contains("let _ = this[3]", rendered, StringComparison.Ordinal);
        Assert.Contains("local = 4", rendered, StringComparison.Ordinal);
        Assert.Contains("local++", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(91235, result.Value);
    }

    [Fact]
    public void ParenthesizedDeconstructionAssignment_WritesTargetsAndEvaluatesOnce()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int calls;

                private (int, int) Get()
                {
                    calls++;
                    return (1, 2);
                }

                public int Run()
                {
                    int a = 0;
                    int b = 0;
                    _ = ((a, b) = Get());
                    return (calls * 100) + (a * 10) + b;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(112, result.Value);
    }

    [Fact]
    public void NestedAssignmentShapes_PreserveBranchesValuesAndOrder()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int trace;

                private (int, int) Next(int marker)
                {
                    trace = (trace * 10) + marker;
                    return (marker, marker + 1);
                }

                private int Observe((int, int) value)
                {
                    trace = (trace * 10) + value.Item1;
                    return value.Item2;
                }

                public int Run()
                {
                    int a = 0;
                    int b = 0;
                    _ = Observe(((a, b) = Next(2)));
                    _ = true ? ((a, b) = Next(3)) : ((a, b) = Next(8));
                    _ = 0 switch
                    {
                        0 => ((a, b) = Next(4)),
                        _ => ((a, b) = Next(9)),
                    };
                    _ = (a = 6);
                    _ = (a += 1);
                    return (trace * 100) + (a * 10) + b;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(223475, result.Value);
    }

    [Fact]
    public void NestedDeconstruction_PreservesEarlierCallArgumentOrder()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int trace;

                private int Mark(int value)
                {
                    trace = (trace * 10) + value;
                    return value;
                }

                private (int, int) Pair()
                {
                    trace = (trace * 10) + 2;
                    return (2, 3);
                }

                private int Observe(int first, (int, int) pair)
                {
                    trace = (trace * 10) + 5;
                    return first + pair.Item1;
                }

                public int Run()
                {
                    int a = 0;
                    int b = 0;
                    _ = Observe(Mark(1), ((a, b) = Pair()));
                    return trace;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(125, result.Value);
    }

    [Fact]
    public void ConditionalAndSwitchArmNestedDeconstruction_PreserveArgumentOrder()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int trace;

                private int Mark(int value)
                {
                    trace = (trace * 10) + value;
                    return value;
                }

                private (int, int) Pair()
                {
                    trace = (trace * 10) + 2;
                    return (2, 3);
                }

                private int Observe(int first, (int, int) pair)
                {
                    trace = (trace * 10) + 5;
                    return first + pair.Item1;
                }

                public int Run()
                {
                    int a = 0;
                    int b = 0;
                    _ = 0 switch
                    {
                        0 => Observe(Mark(1), ((a, b) = Pair())),
                        _ => 0,
                    };
                    _ = true
                        ? Observe(Mark(3), ((a, b) = Pair()))
                        : 0;
                    return trace;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(125325, result.Value);
    }

    [Fact]
    public void NestedDeconstruction_PreservesReceiverBeforeArguments()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int trace;

                private Probe Receiver()
                {
                    trace = (trace * 10) + 1;
                    return this;
                }

                private (int, int) Pair()
                {
                    trace = (trace * 10) + 2;
                    return (2, 3);
                }

                private int Observe((int, int) pair)
                {
                    trace = (trace * 10) + 5;
                    return pair.Item1;
                }

                public int Run()
                {
                    int a = 0;
                    int b = 0;
                    _ = Receiver().Observe(((a, b) = Pair()));
                    return trace;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(125, result.Value);
    }

    [Fact]
    public void NestedDeconstruction_PreservesConstructorAndIndexerArgumentOrder()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int trace;

                public Probe()
                {
                }

                private Probe(int first, (int, int) pair, Probe owner)
                {
                    owner.trace = (owner.trace * 10) + 5;
                }

                private int this[int value]
                {
                    get
                    {
                        trace = (trace * 10) + 5;
                        return value;
                    }
                }

                private int Mark(int value)
                {
                    trace = (trace * 10) + value;
                    return value;
                }

                private (int, int) Pair()
                {
                    trace = (trace * 10) + 2;
                    return (2, 3);
                }

                public int Run()
                {
                    int a = 0;
                    int b = 0;
                    _ = new Probe(Mark(1), ((a, b) = Pair()), this);
                    int constructorTrace = trace;
                    trace = 0;
                    _ = this[Mark(1) + ((a, b) = Pair()).Item1];
                    return (constructorTrace * 1000) + trace;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(125125, result.Value);
    }

    [Fact]
    public void EarlierThrow_PreventsNestedDeconstructionEvaluation()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int trace;

                private int ThrowFirst()
                {
                    trace = (trace * 10) + 1;
                    throw new System.InvalidOperationException();
                }

                private (int, int) Pair()
                {
                    trace = (trace * 10) + 2;
                    return (2, 3);
                }

                private static int Observe(int first, (int, int) pair) => first;

                public int Run()
                {
                    int a = 0;
                    int b = 0;
                    try
                    {
                        _ = Observe(ThrowFirst(), ((a, b) = Pair()));
                    }
                    catch (System.InvalidOperationException)
                    {
                    }

                    return trace;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void ConditionalPostfix_DiscardExecutesOnlySelectedBranch()
    {
        string rendered = Render("""
            public static class Probe
            {
                public static int Run()
                {
                    int i = 0;
                    int j = 0;
                    bool pickFirst = true;
                    _ = pickFirst ? i++ : j++;
                    return (i * 10) + j;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void DeconstructionRhsPostfix_ExecutesExactlyOnce()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int calls;

                private (int, int) Next(int marker)
                {
                    calls++;
                    return (marker + 1, marker + 2);
                }

                private static int Observe((int, int) value) => value.Item1;

                public int Run()
                {
                    int i = 0;
                    int a = 0;
                    int b = 0;
                    _ = Observe(((a, b) = Next(i++)));
                    return (calls * 1000) + (i * 100) + (a * 10) + b;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(1112, result.Value);
    }

    [Fact]
    public void SwitchArmIncrement_DiscardKeepsEffectsBranchLocal()
    {
        string rendered = Render("""
            public static class Probe
            {
                public static int Run()
                {
                    int i = 0;
                    int j = 0;
                    int k = 0;
                    int l = 0;
                    _ = 0 switch
                    {
                        0 => i++,
                        _ => j++,
                    };
                    _ = 0 switch
                    {
                        0 => ++k,
                        _ => ++l,
                    };
                    return (i * 1000) + (j * 100) + (k * 10) + l;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(1010, result.Value);
    }

    [Fact]
    public void SwitchArmPostfixCall_PreservesOldValueAndOperandOrder()
    {
        string rendered = Render("""
            public static class Probe
            {
                private static int observed;

                private static int Observe(int before, int after)
                {
                    observed = ((before + 1) * 10) + after;
                    return observed;
                }

                public static int Run()
                {
                    int i = 0;
                    _ = 0 switch
                    {
                        0 => Observe(i++, i),
                        _ => 0,
                    };
                    return observed;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void ConditionalPostfixCall_PreservesOldValueAndOperandOrder()
    {
        string rendered = Render("""
            public static class Probe
            {
                private static int observed;

                private static int Observe(int before, int after)
                {
                    observed = ((before + 1) * 10) + after;
                    return observed;
                }

                public static int Run()
                {
                    int i = 0;
                    _ = true ? Observe(i++, i) : 0;
                    return observed;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void ShortCircuitedPostfix_DiscardRunsOnlyEvaluatedOperands()
    {
        string rendered = Render("""
            #nullable enable

            public sealed class Probe
            {
                private int Observe(int value) => value;

                public static int Run()
                {
                    int i = 0;
                    int j = 0;
                    int? present = 1;
                    int? missing = null;
                    Probe? absent = null;
                    _ = present ?? i++;
                    _ = missing ?? j++;
                    _ = absent?.Observe(i++);
                    return (i * 10) + j;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void ThrowingGetter_IsStillEvaluated()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int Value => throw new System.InvalidOperationException("discarded");

                public int Run()
                {
                    _ = Value;
                    return 1;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.IsType<InvalidOperationException>(result.UnhandledException);
    }

    [Fact]
    public void NullableForgiveness_DoesNotSuppressRuntimeEvaluation()
    {
        string rendered = Render("""
            #nullable enable

            public static class Probe
            {
                public static int Run(string? value)
                {
                    _ = value!.Length;
                    return 1;
                }
            }
            """);

        Assert.Contains("let _ = value!!.Length", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe.Run(nil)");
        Assert.IsType<NullReferenceException>(result.UnhandledException);
    }

    [Fact]
    public void LambdaBodies_ReuseStatementDiscardTranslation()
    {
        string rendered = Render("""
            using System;

            public sealed class Probe
            {
                private int state;

                private int Touch(int value)
                {
                    state = (state * 10) + value;
                    return state;
                }

                public int Run()
                {
                    Action expressionBody = () => _ = Touch(4);
                    Action blockBody = () => { _ = Touch(5); };
                    expressionBody();
                    blockBody();
                    return state;
                }
            }
            """);

        Assert.Contains("Touch(4)", rendered, StringComparison.Ordinal);
        Assert.Contains("let _ = Touch(5)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(45, result.Value);
    }

    [Fact]
    public void AsyncMethod_DiscardedAwaitRemainsAwaited()
    {
        string rendered = Render("""
            using System.Threading.Tasks;

            public static class Probe
            {
                public static async Task<int> Run()
                {
                    _ = await Task.FromResult(7);
                    return 1;
                }
            }
            """);

        Assert.Contains("let _ = await Task.FromResult(7)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void IteratorBody_DiscardedCallRemainsEvaluated()
    {
        string rendered = Render("""
            using System.Collections.Generic;

            public sealed class Probe
            {
                private int state;

                private int Touch(int value)
                {
                    state = value;
                    return state;
                }

                public IEnumerable<int> Run()
                {
                    _ = Touch(7);
                    yield return state;
                }
            }
            """);

        Assert.Contains("let _ = Touch(7)", rendered, StringComparison.Ordinal);
        Assert.Contains("yield state", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
