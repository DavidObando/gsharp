// <copyright file="Issue2164LazySingletonNullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #2164: the classic lazy-singleton pattern
/// initializes a nullable static/instance field (or auto-property) under a null
/// guard (<c>if (F == null) { F = new(); } ... return F;</c> / <c>F ??= …;</c>),
/// so <c>F</c> is provably non-null at every use dominated by the guard. gsc (by
/// design, Kotlin-style smart casts) narrows only LOCALS, never fields/properties,
/// so the guarded read <c>T? -&gt; T</c> is rejected (GS0155). The migrated corpus
/// is nullable-<em>oblivious</em>, so Roslyn's flow state is empty; cs2gs detects
/// the guard from SYNTAX and emits the established <c>F!!</c> non-null assertion
/// on the guarded use instead.
/// </summary>
public class Issue2164LazySingletonNullForgivenessTranslationTests
{
    [Fact]
    public void LazySingleton_StaticField_EqualsNullGuard_AssertsNonNullReturn()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Service
    {
        private static Service instance;

        public static Service Instance
        {
            get
            {
                if (instance == null)
                {
                    instance = new Service();
                }

                return instance;
            }
        }
    }
}");

        Assert.Contains("private var instance Service?", printed);
        Assert.Contains("return Service.instance!!", printed);
    }

    [Fact]
    public void LazySingleton_StaticField_IsNullGuard_AssertsNonNullReturn()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Service
    {
        private static Service instance;

        public static Service Instance
        {
            get
            {
                if (instance is null)
                {
                    instance = new Service();
                }

                return instance;
            }
        }
    }
}");

        Assert.Contains("return Service.instance!!", printed);
    }

    [Fact]
    public void LazySingleton_CoalesceAssign_AssertsNonNullReturn()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Service
    {
        private static Service instance;

        public static Service Instance
        {
            get
            {
                instance ??= new Service();
                return instance;
            }
        }
    }
}");

        Assert.Contains("!!", printed);
        Assert.Contains("return Service.instance!!", printed);
    }

    [Fact]
    public void LazySingleton_LockWrappedGuard_AssertsNonNullReturn()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Singleton<T> where T : class, new()
    {
        private static readonly object Lockable = new object();
        private static T instance;

        public static T Instance
        {
            get
            {
                lock (Lockable)
                {
                    if (instance is null)
                    {
                        instance = new T();
                    }

                    return instance;
                }
            }
        }
    }
}");

        Assert.Contains("private var instance T?", printed);
        Assert.Contains("return Singleton[T].instance!!", printed);
    }

    [Fact]
    public void LazySingleton_GuardedMemberAccess_AssertsNonNullReceiver()
    {
        // A use of `instance` dominated by the guard that is NOT a trailing
        // `return` (here `instance.ToString()`) is asserted too.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Service
    {
        private static Service instance;

        public static string Name
        {
            get
            {
                if (instance == null)
                {
                    instance = new Service();
                }

                return instance.ToString();
            }
        }
    }
}");

        Assert.Contains("Service.instance!!.ToString()", printed);
    }

    [Fact]
    public void NonNullableField_NoGuard_IsNotAsserted()
    {
        // A field that is never null-checked / null-assigned is not nullable in
        // G#, so no `!!` must be emitted on its return.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Service
    {
        private static readonly Service instance = new Service();

        public static Service Instance
        {
            get
            {
                return instance;
            }
        }
    }
}");

        Assert.DoesNotContain("!!", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
