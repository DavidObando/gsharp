// <copyright file="Issue4212NamedFunctionInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue4212NamedFunctionInvocationTests
{
    [Theory]
    [InlineData("d(c: 7)", "127")]
    [InlineData("d.Invoke(c: 7)", "127")]
    [InlineData("d(a: 9, c: 7)", "927")]
    [InlineData("d(c: 7, b: 8, a: 9)", "987")]
    [InlineData("d(a: 9, b: 8, c: 7)", "987")]
    [InlineData("d(9, c: 7, b: 8)", "987")]
    [InlineData("d()", "123")]
    [InlineData("d(9, 8, 7)", "987")]
    public void Delegate_ArgumentsBindByOrdinal(string call, string expected)
    {
        string printed = Verify($$"""
            namespace Demo
            {
                public delegate int D(int a = 1, int b = 2, int c = 3);
                public class C
                {
                    public void Run()
                    {
                        D d = (a, b, c) => a * 100 + b * 10 + c;
                        System.Console.WriteLine({{call}});
                    }
                }
            }
            """, expected);

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("c:", printed, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Add(c: 7, b: 8, a: 9)", "987")]
    [InlineData("Add(a: 9, b: 8, c: 7)", "987")]
    [InlineData("Add(9, c: 7, b: 8)", "987")]
    [InlineData("Add(9, 8, 7)", "987")]
    public void ClaimedLocalFunction_FullArityWithoutDefaults(string call, string expected)
    {
        string printed = Verify($$"""
            namespace Demo
            {
                public class C
                {
                    public void Run()
                    {
                        int Add(int a, int b, int c)
                        {
                            return a > 100 ? Partner(a - 1) : a * 100 + b * 10 + c;
                        }
                        int Partner(int n) { return Add(n, 2, 3); }
                        System.Console.WriteLine({{call}});
                    }
                }
            }
            """, expected);

        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.Contains("Add!!(9, 8, 7)", printed, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PermutedArguments_SnapshotReadsAndEvaluateOnce(bool claimed)
    {
        string declaration = claimed
            ? """
                int Add(int a = 1, int b = 2, int c = 3)
                {
                    return a > 100 ? Partner(a - 1) : a * 100 + b * 10 + c;
                }
                int Partner(int n) { return Add(n); }
                """
            : "D Add = (a, b, c) => a * 100 + b * 10 + c;";
        string printed = Verify($$"""
            namespace Demo
            {
                public delegate int D(int a = 1, int b = 2, int c = 3);
                public class C
                {
                    public void Run()
                    {
                        int x = 5;
                        int order = 0;
                        int Next(int digit) { order = order * 10 + digit; x = 99; return digit; }
                        {{declaration}}
                        int result = Add(c: x, b: Next(8), a: Next(9));
                        System.Console.WriteLine(result + ":" + order);
                    }
                }
            }
            """, "985:89");

        Assert.Contains("= x", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("c:", printed, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("d")]
    [InlineData("d.Invoke")]
    [InlineData("Get()")]
    [InlineData("Get().Invoke")]
    public void Delegate_ReceiverCapturedBeforeArguments(string target)
    {
        Verify($$"""
            namespace Demo
            {
                public delegate int D(int a = 1, int b = 2, int unused = 0);
                public class C
                {
                    public void Run()
                    {
                        int order = 0;
                        D d = (a, b, unused) => a * 10 + b;
                        D Get() { order = order * 10 + 1; return d; }
                        int Next(int digit)
                        {
                            order = order * 10 + digit;
                            d = (a, b, unused) => 999;
                            return digit;
                        }
                        int result = {{target}}(b: Next(2), a: Next(3));
                        System.Console.WriteLine(result + ":" + order);
                    }
                }
            }
            """, target.StartsWith("Get", StringComparison.Ordinal) ? "32:123" : "32:23");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PermutedArguments_StayAtInvocationEvaluationPoint(bool claimed)
    {
        string declaration = claimed
            ? """
                int Add(int a, int b)
                {
                    return a > 100 ? Partner(a - 1) : a * 10 + b;
                }
                int Partner(int n) { return Add(n, 2); }
                """
            : "D Add = (a, b, unused) => a * 10 + b;";
        Verify($$"""
            namespace Demo
            {
                public delegate int D(int a, int b, int unused = 0);
                public class C
                {
                    public void Run()
                    {
                        int order = 0;
                        int Next(int digit) { order = order * 10 + digit; return digit; }
                        {{declaration}}
                        int sum = Next(1) + Add(b: Next(2), a: Next(3));
                        bool skip = false;
                        bool ignored = skip && Add(b: Next(4), a: Next(5)) > 0;
                        int iteration = 0;
                        while (iteration < 2 && Add(b: Next(6), a: Next(7)) > 0) { iteration++; }
                        System.Console.WriteLine(sum + ":" + order + ":" + iteration + ":" + ignored);
                    }
                }
            }
            """, "33:1236767:2:False");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConditionalDelegate_ArgumentsRunOnlyForNonNullReceiver(bool returnsVoid)
    {
        string resultType = returnsVoid ? "void" : "int";
        string body = returnsVoid ? "{ total = a * 10 + b; }" : "{ total = a * 10 + b; return total; }";
        Verify($$"""
            #nullable enable
            namespace Demo
            {
                public delegate {{resultType}} D(int a = 1, int b = 2, int unused = 0);
                public class C
                {
                    public void Run()
                    {
                        int order = 0;
                        int total = 0;
                        D? d = null;
                        int Next(int digit) { order = order * 10 + digit; d = null; return digit; }
                        d?.Invoke(b: Next(8), a: Next(9));
                        d = (a, b, unused) => {{body}};
                        d?.Invoke(b: Next(2), a: Next(3));
                        System.Console.WriteLine(total + ":" + order);
                    }
                }
            }
            """, "32:23");
    }

    [Theory]
    [InlineData("ref", "cell = a + bonus;", "105")]
    [InlineData("out", "cell = a + bonus;", "105")]
    [InlineData("in", "observed = a + cell + bonus;", "115")]
    public void Delegate_RefKindArgumentCapturesAddressInSourceOrder(
        string refKind, string body, string expected)
    {
        Verify($$"""
            namespace Demo
            {
                public delegate void D(int a, {{refKind}} int cell, int bonus = 100);
                public class C
                {
                    public void Run()
                    {
                        int order = 0;
                        int observed = 0;
                        int[] slots = new int[2];
                        int[] original = slots;
                        int Idx() { order = order * 10 + 1; return 1; }
                        int Val()
                        {
                            order = order * 10 + 2;
                            original[1] = 10;
                            slots = new int[2];
                            return 5;
                        }
                        D d = (int a, {{refKind}} int cell, int bonus) => { {{body}} };
                        d(cell: {{refKind}} slots[Idx()], a: Val());
                        System.Console.WriteLine(
                            {{(refKind == "in" ? "observed" : "original[1]")}} + ":" + slots[1] + ":" + order);
                    }
                }
            }
            """, expected + ":0:12");
    }

    [Fact]
    public void Delegate_OutDeclarationRemainsVisibleAfterReorderedCall()
    {
        Verify("""
            namespace Demo
            {
                public delegate void D(int a, out int cell, int bonus = 100);
                public class C
                {
                    public void Run()
                    {
                        int Val() { return 5; }
                        D d = (int a, out int cell, int bonus) => { cell = a + bonus; };
                        d(cell: out int value, a: Val());
                        System.Console.WriteLine(value);
                    }
                }
            }
            """, "105");
    }

    [Theory]
    [InlineData("d(xs: new int[] { 2, 3 })", "6")]
    [InlineData("d(xs: new int[] { 2, 3 }, a: 9)", "14")]
    [InlineData("d(a: 9, 2, 3)", "14")]
    [InlineData("d()", "1")]
    public void Delegate_ParamsArrayForms(string call, string expected)
    {
        Verify($$"""
            namespace Demo
            {
                public delegate int D(int a = 1, params int[] xs);
                public class C
                {
                    public void Run()
                    {
                        D d = (int a, params int[] xs) =>
                        {
                            int sum = a;
                            foreach (int x in xs) { sum += x; }
                            return sum;
                        };
                        System.Console.WriteLine({{call}});
                    }
                }
            }
            """, expected);
    }

    [Fact]
    public void Delegate_NumericEnumAndNullDefaults()
    {
        string printed = Verify("""
            #nullable enable
            namespace Demo
            {
                public enum Color { Red, Blue }
                public delegate string D(byte a = 2, Color color = Color.Blue, string? text = null);
                public class C
                {
                    public void Run()
                    {
                        D d = (a, color, text) => a + ":" + color + ":" + (text ?? "nil");
                        System.Console.WriteLine(d(text: "set"));
                        System.Console.WriteLine(d(color: Color.Red, a: 3));
                    }
                }
            }
            """, "2:Blue:set" + Environment.NewLine + "3:Red:nil");

        Assert.DoesNotContain("text:", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedDelegate_NamesNormalizeForStructuralArrow()
    {
        Verify("""
            namespace Demo
            {
                public class C
                {
                    public void Run()
                    {
                        System.Func<int, int, int> f = (x, y) => x * 10 + y;
                        System.Console.WriteLine(f(arg2: 2, arg1: 3));
                    }
                }
            }
            """, "32");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PermutedArguments_EvaluateImplicitConversionsInSourceOrder(bool claimed)
    {
        string declaration = claimed
            ? """
                int Add(int a, Box b)
                {
                    return a > 100 ? Partner(a - 1) : a * 10 + b.Value;
                }
                int Partner(int n) { return Add(n, 3); }
                """
            : "D Add = (a, b) => a * 10 + b.Value;";
        Verify($$"""
            namespace Demo
            {
                public class Box
                {
                    public int Value;
                    public static implicit operator Box(int value)
                    {
                        C.Order = C.Order * 10 + value;
                        return new Box { Value = value };
                    }
                }
                public delegate int D(int a, Box b);
                public class C
                {
                    public static int Order;
                    public void Run()
                    {
                        int Next() { Order = Order * 10 + 2; return 2; }
                        {{declaration}}
                        int result = Add(b: 3, a: Next());
                        System.Console.WriteLine(result + ":" + Order);
                    }
                }
            }
            """, "23:32");
    }

    [Fact]
    public void Delegate_ImplicitInRvalueGetsValueTemporary()
    {
        Verify("""
            namespace Demo
            {
                public delegate int D(int a, in int b, int unused = 0);
                public class C
                {
                    public void Run()
                    {
                        int order = 0;
                        int Next(int x) { order = order * 10 + x; return x; }
                        D d = (int a, in int b, int unused) => a * 10 + b;
                        int result = d(b: Next(2), a: Next(3));
                        System.Console.WriteLine(result + ":" + order);
                    }
                }
            }
            """, "32:23");
    }

    [Fact]
    public void Delegate_FieldInitializerAndExpressionBodyKeepLocalSpillScope()
    {
        Verify("""
            namespace Demo
            {
                public delegate int D(int a, int b);
                public class C
                {
                    private static int order;
                    private static D d = (a, b) => a * 10 + b;
                    private int value = d(b: Next(2), a: Next(3));
                    private static int Next(int digit) { order = order * 10 + digit; return digit; }
                    private int Read() => d(b: Next(4), a: Next(5));
                    public void Run()
                    {
                        int result = Read();
                        System.Console.WriteLine(value + ":" + result + ":" + order);
                    }
                }
            }
            """, "32:54:2345");
    }

    [Theory]
    [InlineData("d!")]
    [InlineData("(d!)")]
    [InlineData("d!.Invoke")]
    [InlineData("(d!).Invoke")]
    public void Delegate_NullTargetStillEvaluatesArgumentsBeforeThrowing(string target)
    {
        Verify($$"""
            #nullable enable
            namespace Demo
            {
                public delegate int D(int a, int b, int unused = 0);
                public class C
                {
                    public void Run()
                    {
                        int order = 0;
                        int Next(int digit) { order = order * 10 + digit; return digit; }
                        D? d = null;
                        try { {{target}}(b: Next(2), a: Next(3)); }
                        catch (System.NullReferenceException) { System.Console.WriteLine(order); }
                    }
                }
            }
            """, "23");
    }

    [Fact]
    public void ConditionalDelegate_NestedContinuationsUseTheirOwnReceiver()
    {
        Verify("""
            #nullable enable
            namespace Demo
            {
                public delegate int? D(int a = 1, int b = 2, int unused = 0);
                public class C
                {
                    public void Run()
                    {
                        int order = 0;
                        int Next(int digit) { order = order * 10 + digit; return digit; }
                        D? d = (a, b, unused) => a * 10 + b;
                        D? other = null;
                        string? first = d?.Invoke(b: Next(2), a: Next(3))?.ToString();
                        int? second = d?.Invoke(b: other?.Invoke() ?? 0, a: Next(4));
                        d = null;
                        string? last = d?.Invoke(b: Next(5), a: Next(6))?.ToString();
                        System.Console.WriteLine(first + ":" + second + ":" + (last ?? "nil") + ":" + order);
                    }
                }
            }
            """, "32:40:nil:234");
    }

    [Fact]
    public void Delegate_AwaitedArgumentsKeepSourceOrder()
    {
        Verify("""
            using System.Threading.Tasks;
            namespace Demo
            {
                public delegate int D(int a, int b, int unused = 0);
                public class C
                {
                    private int order;
                    private async Task<int> Next(int digit)
                    {
                        await Task.Yield();
                        order = order * 10 + digit;
                        return digit;
                    }
                    private async Task<int> Read()
                    {
                        D d = (a, b, unused) => a * 10 + b;
                        return d(b: await Next(2), a: await Next(3));
                    }
                    public void Run()
                    {
                        int result = Read().GetAwaiter().GetResult();
                        System.Console.WriteLine(result + ":" + order);
                    }
                }
            }
            """, "32:23");
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void Delegate_EntryPointRefSpillsStayStackLocal(bool topLevel, bool returnsValue)
    {
        string returnType = returnsValue ? "int" : "void";
        string declaration = $"public delegate {returnType} D(int a, ref int cell, int bonus = 100);";
        string body = $$"""
            int[] order = new int[1];
            int[] cells = new int[1];
            D d = (int a, ref int cell, int bonus) =>
            {
                cell = a + bonus;
                {{(returnsValue ? "return cell;" : string.Empty)}}
            };
            {{(returnsValue ? "int result = " : string.Empty)}}d(
                cell: ref cells[(order[0] = 1) - 1], a: (order[0] = order[0] * 10 + 2) - 7);
            System.Console.WriteLine({{(returnsValue ? "result" : "cells[0]")}} + ":" + order[0]);
            """;
        string source = topLevel
            ? body + "\n" + declaration
            : declaration + "\npublic static class Program { public static void Main() { " + body + " } }";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", source) },
            outputKind: OutputKind.ConsoleApplication);
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        TranslationTestValidation.AssertBinds(printed);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "105:12");
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void ConditionalDelegate_OutDeclarationUsesEnclosingScope(bool returnsValue, bool present)
    {
        Verify($$"""
            #nullable enable
            namespace Demo
            {
                public delegate {{(returnsValue ? "int" : "void")}} D(int a, out int cell);
                public class C
                {
                    public void Run()
                    {
                        int calls = 0;
                        int observed = 0;
                        int Next() { calls++; return 42; }
                        D? d = null;
                        if ({{(present ? "true" : "false")}})
                        {
                            d = (int a, out int cell) =>
                            {
                                cell = a;
                                observed = cell;
                                {{(returnsValue ? "return cell;" : string.Empty)}}
                            };
                        }
                        {{(returnsValue ? "int? returned = " : string.Empty)}}d?.Invoke(cell: out int value, a: Next());
                        value = 7;
                        System.Console.WriteLine(value + ":" + observed + ":" + calls{{(returnsValue ? " + \":\" + (returned ?? -1)" : string.Empty)}});
                    }
                }
            }
            """, (present ? "7:42:1" : "7:0:0") + (returnsValue ? (present ? ":42" : ":-1") : string.Empty));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Delegate_TernaryOutDeclarationUsesEnclosingScope(bool enabled)
    {
        Verify($$"""
            namespace Demo
            {
                public delegate int D(int a, out int cell);
                public class C
                {
                    public void Run()
                    {
                        int calls = 0;
                        int Next() { calls++; return calls; }
                        D d = (int a, out int cell) => { cell = a; return a; };
                        bool enabled = {{(enabled ? "true" : "false")}};
                        int answer = enabled ? d(cell: out int value, a: Next()) : 0;
                        value = 7;
                        System.Console.WriteLine(value + ":" + answer + ":" + calls);
                    }
                }
            }
            """, enabled ? "7:1:1" : "7:0:0");
    }

    [Fact]
    public void Delegate_NestedArgumentOutDeclarationUsesEnclosingScope()
    {
        Verify("""
            namespace Demo
            {
                public delegate int D(int a, out int cell);
                public class C
                {
                    public void Run()
                    {
                        int calls = 0;
                        int Next() { calls++; return calls; }
                        D d = (int a, out int cell) => { cell = a; return a; };
                        System.Func<int, int, int> sum = (a, b) => a + b;
                        int answer = sum(arg2: d(cell: out int value, a: Next()), arg1: Next());
                        value = 7;
                        System.Console.WriteLine(value + ":" + answer + ":" + calls);
                    }
                }
            }
            """, "7:3:2");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConditionalDelegate_OutDeclarationStaysInsideExpressionBody(bool localFunction)
    {
        string declaration = localFunction ? "int Read() =>" : "System.Func<int> Read = () =>";
        Verify($$"""
            #nullable enable
            namespace Demo
            {
                public delegate int D(int a, out int cell);
                public class C
                {
                    public void Run()
                    {
                        int calls = 0;
                        int Next() { calls++; return calls; }
                        D? d = null;
                        {{declaration}} (d?.Invoke(cell: out int value, a: Next()) ?? 0) + (value = 7);
                        int answer = Read();
                        d = (int a, out int cell) => { cell = a; return a; };
                        answer += Read();
                        System.Console.WriteLine(answer + ":" + calls);
                    }
                }
            }
            """, "15:1");
    }

    private static string Verify(string source, string expected)
    {
        string printed = LocalFunctionHoistTranslationTests.TranslateUnit(source);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().Run()", expected);
        return printed;
    }
}
