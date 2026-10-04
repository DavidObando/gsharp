// <copyright file="Issue4679NamedBclDelegateIdentityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Threading;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4679NamedBclDelegateIdentityTranslationTests
{
    [Theory]
    [InlineData("Predicate<string>", typeof(Predicate<string>))]
    [InlineData("Predicate<>", typeof(Predicate<>))]
    [InlineData("Predicate<string>[]", typeof(Predicate<string>[]))]
    [InlineData("List<Predicate<string>>", typeof(List<Predicate<string>>))]
    [InlineData("Func<Predicate<string>>", typeof(Func<Predicate<string>>))]
    [InlineData("(Predicate<string>, int)", typeof(ValueTuple<Predicate<string>, int>))]
    [InlineData("Comparison<string>", typeof(Comparison<string>))]
    [InlineData("(Comparison<string>, int)", typeof(ValueTuple<Comparison<string>, int>))]
    [InlineData("Converter<string, int>", typeof(Converter<string, int>))]
    [InlineData("ThreadStart", typeof(ThreadStart))]
    [InlineData("Func<ThreadStart>", typeof(Func<ThreadStart>))]
    [InlineData("Action<string>", typeof(Action<string>))]
    [InlineData("Func<string, bool>", typeof(Func<string, bool>))]
    public void TypeOf_PreservesExactClrIdentity(string type, Type expected)
    {
        string printed = Translate($$"""
            using System;
            using System.Collections.Generic;
            using System.Threading;

            public class Probe
            {
                public Type Observe() => typeof({{type}});
            }
            """);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Probe().Observe()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void CastsPatternsAndGenericArguments_ObserveTheOriginalDelegate()
    {
        string printed = Translate("""
            using System;

            public class Probe
            {
                public Type Identity<T>() => typeof(T);
                public Type Infer<T>(T value) => typeof(T);

                public bool Observe()
                {
                    var predicate = new Predicate<string>(value => value.Length > 0);
                    object boxed = predicate;
                    var converted = (Predicate<string>)boxed;
                    var safe = boxed as Predicate<string>;
                    return boxed.GetType() == typeof(Predicate<string>)
                        && boxed is Predicate<string>
                        && boxed is Predicate<string> matched && matched("x")
                        && !(boxed is Func<string, bool>)
                        && converted("x")
                        && safe != null && safe("x")
                        && Identity<Predicate<string>>() == typeof(Predicate<string>)
                        && Infer(predicate) == typeof(Predicate<string>);
                }
            }
            """);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Probe().Observe()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(true, result.Value);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        return printed;
    }
}
