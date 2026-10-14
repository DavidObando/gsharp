// <copyright file="Issue2421AsyncReturnTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import Xunit

/// Translator-fidelity tests for issue #2421: an `async Task<T>` method,
/// local function, or lambda whose body forwards an already-nullable value
/// must be promoted to `T?` by the same whole-program oblivious-nullability
/// taint analysis ((cref:ObliviousNullabilityAnalyzer)) that the
/// SYNCHRONOUS return path already applies (issues #2157/#2167). Prior to this
/// fix, `CSharpToGSharpTranslator.MapReturnType` and
/// `MapDelegateLikeReturnType` both unwrapped an `async Task<T>`
/// return and returned the mapped `T` IMMEDIATELY, before ever reaching the
/// tuple/scalar return-taint promotion the sync path applies unconditionally —
/// so the literal async equivalent of an already-covered sync forwarding
/// pattern silently skipped promotion and produced a `T? -> T` mismatch at
/// the call site (GS0155/GS0156). A companion gap in the same taint graph
/// ((cref:ObliviousNullabilityAnalyzer.IsDirectlyNullable) /
/// `ResolveSources` ) had no case for `AwaitExpressionSyntax`, so
/// `return await TaintedCall();` never created a transitive taint edge to the
/// enclosing method at all; both gaps are covered here.
open class Issue2421AsyncReturnTaintTranslationTests {
    @Fact
    func Oblivious_SyncMethodForwardingTaintedCall_IsPromotedToNullable() {
        // Negative control (issue #2167 behavior, unaffected by this fix):
        // a synchronous method whose body forwards the result of a call whose
        // OWN return is nullable must itself be promoted to `T?`.
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("func GetSortedName() string?", printed)
    }

    @Fact
    func Oblivious_AsyncMethodForwardingTaintedCall_IsPromotedToNullable() {
        // The literal async equivalent of the sync case above — the exact
        // Oahu.Core `Authorize.GetRegisteredProfilesAsync` shape: an `async
        // Task<T>` method forwarding a call whose own return is nullable.
        // Before the fix, MapReturnType's async-unwrap branch returned before
        // ever applying PromoteReturnIfTainted, so this stayed `string`
        // (never promoted) and the caller-side `await` produced a `string? ->
        // string` mismatch.
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("async func GetSortedNameAsync() string?", printed)
    }

    @Fact
    func Oblivious_AsyncMethodForwardingTaintedCall_ExpressionBodied_IsPromotedToNullable() {
        // Same shape, but as an arrow-bodied `async Task<T>` method (the exact
        // AudibleClient.GetProfileAliasAsync / Authorize.GetRegisteredProfilesAsync
        // rendering; MapReturnType handles both block- and expression-bodied
        // async methods identically).
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("async func GetSortedNameAsync() string?", printed)
    }

    @Fact
    func Oblivious_AsyncMethodReturningTaintedAwaitedCall_IsPromotedToNullable() {
        // Covers the companion AwaitExpressionSyntax gap: `return await
        // OtherTaintedAsyncCall();` must create a transitive taint edge to the
        // enclosing method (ResolveSources), and the awaited call's own
        // nullability must be visible to IsDirectlyNullable/taint seeding.
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("async func GetSortedAsync() string?", printed)
        Assert.Contains("async func ForwardAsync() string?", printed)
    }

    @Fact
    func Oblivious_AsyncMethodReturningTaintedElementTuple_OnlyThatElementIsPromoted() {
        // Async tuple return (Task<(bool, IProfile)>-shaped): only the element
        // whose own returned expression is tainted is promoted, mirroring the
        // existing sync tuple-promotion precision guard (issue #914).
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("async func TryFindAsync() (Ok bool, Found IProfile?)", printed)
    }

    @Fact
    func Oblivious_AsyncValueTypedTaskReturn_IsNeverPromoted() {
        // Precision guard: an `async Task<int>` (value-typed T) must never be
        // promoted through this path — PromoteAwaitedReturnIfTainted keys its
        // reference-type guard off the UNWRAPPED awaited type, not the
        // `Task<T>` envelope (which is always a reference type).
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("async func CountAsync() int32", printed)
        Assert.DoesNotContain("int32?", printed)
    }

    @Fact
    func Oblivious_AsyncLocalFunctionForwardingTaintedCall_IsPromotedToNullable() {
        // A capturing local function renders via a different emission path
        // (`let Name = async func (...) ... { ... }`, TranslateLocalFunction)
        // than a capture-free top-level local function
        // (TranslateTopLevelLocalFunctionAsFunc); both reach
        // MapDelegateLikeReturnType, and this exercises the capturing path.
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("let GetSortedNameAsync = async func () string?", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
