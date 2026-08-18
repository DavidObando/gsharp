// <copyright file="Issue3419FallbackPatternHoistTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3419: fallback pattern spills preserve short-circuit order, and
/// reassigned pattern binders have mutable storage.
/// </summary>
public sealed class Issue3419FallbackPatternHoistTranslationTests
{
    [Fact]
    public void ShortCircuitedFallbackScrutinees_StayBehindGuardsAcrossSurfaces()
    {
        string printed = Translate(
            """
            namespace Demo
            {
                public sealed class Payload
                {
                    public int Value;
                }

                public sealed class Holder
                {
                    private readonly Payload payload = new Payload { Value = 7 };

                    public int Reads;

                    public Payload Payload
                    {
                        get
                        {
                            Reads++;
                            return payload;
                        }
                    }
                }

                public static class C
                {
                    private static int calls;

                    private static Payload Read(bool shouldThrow)
                    {
                        calls++;
                        if (shouldThrow)
                        {
                            throw new System.InvalidOperationException();
                        }

                        return new Payload { Value = 7 };
                    }

                    private static object ReadObject(bool shouldThrow) =>
                        Read(shouldThrow);

                    private static int Statement(bool guard, bool shouldThrow)
                    {
                        if (guard
                            && Read(shouldThrow) is { Value: var value }
                            && value > 0)
                        {
                            return value;
                        }

                        return 0;
                    }

                    private static bool Boolean(bool guard, bool shouldThrow) =>
                        guard
                        && Read(shouldThrow) is { Value: var value }
                        && value > 0;

                    private static int Conditional(bool guard, bool shouldThrow) =>
                        guard
                        && Read(shouldThrow) is { Value: var value }
                            ? value
                            : 0;

                    private static int NullableReceiver(Holder? holder)
                    {
                        if (holder != null
                            && holder.Payload is { Value: var value }
                            && value > 0)
                        {
                            return value;
                        }

                        return 0;
                    }

                    private static int MutableTypedBinder(bool guard, bool shouldThrow)
                    {
                        if (guard
                            && ReadObject(shouldThrow) is Payload payload
                            && payload.Value > 0)
                        {
                            payload = new Payload { Value = payload.Value + 1 };
                            return payload.Value;
                        }

                        return 0;
                    }

                    public static string Run()
                    {
                        calls = 0;
                        int statementFalse = Statement(false, true);
                        bool booleanFalse = Boolean(false, true);
                        int conditionalFalse = Conditional(false, true);
                        int statementTrue = Statement(true, false);
                        bool booleanTrue = Boolean(true, false);
                        int conditionalTrue = Conditional(true, false);
                        int nullableFalse = NullableReceiver(null);
                        var holder = new Holder();
                        int nullableTrue = NullableReceiver(holder);
                        int mutableFalse = MutableTypedBinder(false, true);
                        int mutableTrue = MutableTypedBinder(true, false);
                        return statementFalse + "," + booleanFalse + "," + conditionalFalse
                            + "," + statementTrue + "," + booleanTrue + "," + conditionalTrue
                            + "," + nullableFalse + "," + nullableTrue + "," + holder.Reads
                            + "," + mutableFalse + "," + mutableTrue + "," + calls;
                    }
                }
            }
            """);

        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C.Run())",
            "0,False,0,7,True,7,0,7,1,0,8,4");
    }

    [Fact]
    public void ReassignedReferenceBinder_IsDeclaredMutableAndRemainsNonNullInBody()
    {
        string printed = Translate(
            """
            #nullable enable

            namespace Demo
            {
                public sealed class Node
                {
                    public string? StartTag;
                }

                public static class C
                {
                    public static string Read(Node node)
                    {
                        if (node.StartTag is { } startTag)
                        {
                            startTag = startTag + "!";
                            return startTag;
                        }

                        return "none";
                    }

                    public static string ReadAfterGuard(Node node)
                    {
                        if (node.StartTag is { } startTag)
                        {
                        }
                        else
                        {
                            return "none";
                        }

                        startTag = startTag + "!";
                        return startTag;
                    }

                    public static string Conditional(Node node) =>
                        node.StartTag is { } startTag
                            ? startTag = startTag + "!"
                            : "none";

                    public static string Negated(object value) =>
                        value is not string text
                            ? "none"
                            : text = text + "!";
                }
            }
            """);

        Assert.Contains("var startTag string?", printed, StringComparison.Ordinal);
        Assert.Contains("startTag =", printed, StringComparison.Ordinal);
        Assert.Contains("+ \"!\"", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            """
            let node = Node()
            node.StartTag = "open"
            Console.WriteLine(C.Read(node))
            Console.WriteLine(C.Read(Node()))
            Console.WriteLine(C.ReadAfterGuard(node))
            Console.WriteLine(C.ReadAfterGuard(Node()))
            Console.WriteLine(C.Conditional(node))
            Console.WriteLine(C.Conditional(Node()))
            Console.WriteLine(C.Negated("open"))
            Console.WriteLine(C.Negated(1))
            """,
            string.Join(
                Environment.NewLine,
                "open!",
                "none",
                "open!",
                "none",
                "open!",
                "none",
                "open!",
                "none"));
    }

    [Fact]
    public void ReassignedValueBinder_UsesNonNullableMutableStorage()
    {
        string printed = Translate(
            """
            namespace Demo
            {
                public sealed class Node
                {
                    public int? Value;
                }

                public static class C
                {
                    public static int Read(Node node)
                    {
                        if (node.Value is { } value)
                        {
                            value += 1;
                            return value;
                        }

                        return -1;
                    }
                }
            }
            """);

        Assert.Contains("var value int32", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("var value int32?", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            """
            let node = Node()
            node.Value = 5
            Console.WriteLine(C.Read(node))
            Console.WriteLine(C.Read(Node()))
            """,
            "6" + Environment.NewLine + "-1");
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        TranslationTestValidation.AssertBinds(printed);
        return printed;
    }
}
