// <copyright file="Issue2421AsyncReturnTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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
/// Translator-fidelity tests for issue #2421: an `async Task&lt;T&gt;` method,
/// local function, or lambda whose body forwards an already-nullable value
/// must be promoted to `T?` by the same whole-program oblivious-nullability
/// taint analysis (<see cref="ObliviousNullabilityAnalyzer"/>) that the
/// SYNCHRONOUS return path already applies (issues #2157/#2167). Prior to this
/// fix, <c>CSharpToGSharpTranslator.MapReturnType</c> and
/// <c>MapDelegateLikeReturnType</c> both unwrapped an `async Task&lt;T&gt;`
/// return and returned the mapped `T` IMMEDIATELY, before ever reaching the
/// tuple/scalar return-taint promotion the sync path applies unconditionally —
/// so the literal async equivalent of an already-covered sync forwarding
/// pattern silently skipped promotion and produced a `T? -&gt; T` mismatch at
/// the call site (GS0155/GS0156). A companion gap in the same taint graph
/// (<see cref="ObliviousNullabilityAnalyzer.IsDirectlyNullable"/> /
/// <c>ResolveSources</c> ) had no case for `AwaitExpressionSyntax`, so
/// `return await TaintedCall();` never created a transitive taint edge to the
/// enclosing method at all; both gaps are covered here.
/// </summary>
public class Issue2421AsyncReturnTaintTranslationTests
{
    [Fact]
    public void Oblivious_SyncMethodForwardingTaintedCall_IsPromotedToNullable()
    {
        // Negative control (issue #2167 behavior, unaffected by this fix):
        // a synchronous method whose body forwards the result of a call whose
        // OWN return is nullable must itself be promoted to `T?`.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Configuration
    {
        public string GetSorted() => null;
    }

    public class C
    {
        private readonly Configuration configuration = new Configuration();

        public string GetSortedName()
        {
            return configuration.GetSorted();
        }
    }
}");

        Assert.Contains("func GetSortedName() string?", printed);
    }

    [Fact]
    public void Oblivious_AsyncMethodForwardingTaintedCall_IsPromotedToNullable()
    {
        // The literal async equivalent of the sync case above — the exact
        // Oahu.Core `Authorize.GetRegisteredProfilesAsync` shape: an `async
        // Task<T>` method forwarding a call whose own return is nullable.
        // Before the fix, MapReturnType's async-unwrap branch returned before
        // ever applying PromoteReturnIfTainted, so this stayed `string`
        // (never promoted) and the caller-side `await` produced a `string? ->
        // string` mismatch.
        string printed = TranslateOblivious(@"
using System.Threading.Tasks;

namespace Demo
{
    public class Configuration
    {
        public string GetSorted() => null;
    }

    public class C
    {
        private readonly Configuration configuration = new Configuration();

        public async Task<string> GetSortedNameAsync()
        {
            return configuration.GetSorted();
        }
    }
}");

        Assert.Contains("async func GetSortedNameAsync() string?", printed);
    }

    [Fact]
    public void Oblivious_AsyncMethodForwardingTaintedCall_ExpressionBodied_IsPromotedToNullable()
    {
        // Same shape, but as an arrow-bodied `async Task<T>` method (the exact
        // AudibleClient.GetProfileAliasAsync / Authorize.GetRegisteredProfilesAsync
        // rendering; MapReturnType handles both block- and expression-bodied
        // async methods identically).
        string printed = TranslateOblivious(@"
using System.Threading.Tasks;

namespace Demo
{
    public class Configuration
    {
        public string GetSorted() => null;
    }

    public class C
    {
        private readonly Configuration configuration = new Configuration();

        public async Task<string> GetSortedNameAsync() => configuration.GetSorted();
    }
}");

        Assert.Contains("async func GetSortedNameAsync() string?", printed);
    }

    [Fact]
    public void Oblivious_AsyncMethodReturningTaintedAwaitedCall_IsPromotedToNullable()
    {
        // Covers the companion AwaitExpressionSyntax gap: `return await
        // OtherTaintedAsyncCall();` must create a transitive taint edge to the
        // enclosing method (ResolveSources), and the awaited call's own
        // nullability must be visible to IsDirectlyNullable/taint seeding.
        string printed = TranslateOblivious(@"
using System.Threading.Tasks;

namespace Demo
{
    public class Configuration
    {
        public async Task<string> GetSortedAsync() => null;
    }

    public class C
    {
        private readonly Configuration configuration = new Configuration();

        public async Task<string> ForwardAsync()
        {
            return await configuration.GetSortedAsync();
        }
    }
}");

        Assert.Contains("async func GetSortedAsync() string?", printed);
        Assert.Contains("async func ForwardAsync() string?", printed);
    }

    [Fact]
    public void Oblivious_AsyncMethodReturningTaintedElementTuple_OnlyThatElementIsPromoted()
    {
        // Async tuple return (Task<(bool, IProfile)>-shaped): only the element
        // whose own returned expression is tainted is promoted, mirroring the
        // existing sync tuple-promotion precision guard (issue #914).
        string printed = TranslateOblivious(@"
using System.Threading.Tasks;

namespace Demo
{
    public interface IProfile
    {
    }

    public class Profile : IProfile
    {
    }

    public class Configuration
    {
        public Profile Find() => null;
    }

    public class C
    {
        private readonly Configuration configuration = new Configuration();

        public async Task<(bool Ok, IProfile Found)> TryFindAsync()
        {
            return (true, configuration.Find());
        }
    }
}");

        Assert.Contains("async func TryFindAsync() (bool, IProfile?)", printed);
    }

    [Fact]
    public void Oblivious_AsyncValueTypedTaskReturn_IsNeverPromoted()
    {
        // Precision guard: an `async Task<int>` (value-typed T) must never be
        // promoted through this path — PromoteAwaitedReturnIfTainted keys its
        // reference-type guard off the UNWRAPPED awaited type, not the
        // `Task<T>` envelope (which is always a reference type).
        string printed = TranslateOblivious(@"
using System.Threading.Tasks;

namespace Demo
{
    public class Configuration
    {
        public string GetSorted() => null;
    }

    public class C
    {
        private readonly Configuration configuration = new Configuration();

        public async Task<int> CountAsync()
        {
            var ignored = configuration.GetSorted();
            return 0;
        }
    }
}");

        Assert.Contains("async func CountAsync() int32", printed);
        Assert.DoesNotContain("int32?", printed);
    }

    [Fact]
    public void Oblivious_AsyncLocalFunctionForwardingTaintedCall_IsPromotedToNullable()
    {
        // A capturing local function renders via a different emission path
        // (`let Name = async func (...) ... { ... }`, TranslateLocalFunction)
        // than a capture-free top-level local function
        // (TranslateTopLevelLocalFunctionAsFunc); both reach
        // MapDelegateLikeReturnType, and this exercises the capturing path.
        string printed = TranslateOblivious(@"
using System.Threading.Tasks;

namespace Demo
{
    public class Configuration
    {
        public string GetSorted() => null;
    }

    public class C
    {
        public void Run(Configuration configuration)
        {
            async Task<string> GetSortedNameAsync()
            {
                return configuration.GetSorted();
            }

            GetSortedNameAsync();
        }
    }
}");

        Assert.Contains("let GetSortedNameAsync = async func () string?", printed);
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
