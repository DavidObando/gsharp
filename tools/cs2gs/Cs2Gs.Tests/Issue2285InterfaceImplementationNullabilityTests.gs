// <copyright file="Issue2285InterfaceImplementationNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Regression tests for issue #2285: on nullable-<em>oblivious</em> C# source,
/// cs2gs's whole-program taint analysis ((cref:ObliviousNullabilityAnalyzer))
/// used to promote only ONE endpoint of an interface-member/implementation pair to
/// `T?`, leaving the other side non-null `T` — an internally
/// inconsistent translation that gsc's Kotlin-style property-variance check
/// correctly rejects (GS0187: a non-null get-only interface contract cannot be
/// satisfied by a nullable member).
///
/// <b>Root cause</b>: null-checking a member access (e.g. `key.AccountId ==
/// null`) taints the CONCRETE symbol the access binds to — the
/// implementation's own property (or, for a plain class, that exact property).
/// For an ordinary interface member/implementing-property PAIR there was no
/// edge at all connecting the two symbols' taint, so the interface side never
/// saw it. For a C# RECORD positional parameter the gap compounds: Roslyn's
/// synthesized auto-property (the symbol
/// `INamedTypeSymbol.FindImplementationForInterfaceMember` reports, and
/// the one that gets directly tainted by a null-check) is a DIFFERENT symbol
/// from the primary-constructor (cref:IParameterSymbol) that cs2gs's own
/// type-mapping actually renders — so even the record's own emitted G# type was
/// never promoted, regardless of the interface.
///
/// <b>Fix</b>: `ObliviousNullabilityAnalyzer.CollectInterfaceImplementationEdges`
/// walks every source-declared type's implemented interfaces once per
/// compilation and adds BIDIRECTIONAL taint edges between each reference-typed
/// interface property and the property that implements it, so the two
/// endpoints always converge to the same tainted-ness regardless of which side
/// the taint was originally seeded on. For a record positional parameter, the
/// synthesized property's declaring syntax reference IS the parameter syntax
/// node itself, so the corresponding (cref:IParameterSymbol) is resolved
/// from it and wired into the same edge set — bridging the record's rendered
/// parameter to the interface contract too.
open class Issue2285InterfaceImplementationNullabilityTests {
    @Fact
    func RecordPositionalParameterNullChecked_PromotesBothInterfaceAndRecordParameter() {
        // `key.AccountId == null` taints ProfileKey's OWN synthesized property
        // (the symbol Roslyn reports as the interface-member implementation),
        // which is a DIFFERENT symbol from the primary-ctor parameter cs2gs
        // renders. Both the record's rendered parameter AND the interface
        // property's getter must come out `string?` together.
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IProfileKey
    {
        string AccountId { get; }
    }

    public sealed record ProfileKey(string AccountId) : IProfileKey;

    public static class Repro
    {
        public static bool IsEmpty(ProfileKey key) => key.AccountId == null;
    }
}`)
        Assert.Contains("prop AccountId string? {", printed)
        Assert.Contains("data class ProfileKey(AccountId string?) : IProfileKey", printed)
    }

    @Fact
    func OrdinaryClassPropertyNullChecked_PromotesBothInterfaceAndImplementation() {
        // Generalization (per the issue): an ordinary class/property pair, not
        // just a record positional parameter, must also converge.
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IProfileKey
    {
        string AccountId { get; }
    }

    public class OrdinaryImpl : IProfileKey
    {
        public string AccountId { get; set; }
    }

    public static class Repro
    {
        public static bool IsEmpty(OrdinaryImpl impl) => impl.AccountId == null;
    }
}`)
        Assert.Contains("prop AccountId string? {", printed)
        Assert.Contains("prop AccountId string?", printed)
    }

    @Fact
    func NullCheckThroughInterfaceTypedReference_PromotesRecordParameterToo() {
        // Taint may originate from a caller that only holds the INTERFACE-typed
        // reference (not the concrete record type); the fix must still flow the
        // taint back down to the record's own rendered parameter.
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IProfileKey
    {
        string AccountId { get; }
    }

    public sealed record ProfileKey(string AccountId) : IProfileKey;

    public static class Repro
    {
        public static bool IsEmpty(IProfileKey key) => key.AccountId == null;
    }
}`)
        Assert.Contains("prop AccountId string? {", printed)
        Assert.Contains("data class ProfileKey(AccountId string?) : IProfileKey", printed)
    }

    @Fact
    func NoNullCheckAnywhere_InterfaceAndImplementationStayNonNull() {
        // Control: with no taint source at all, neither endpoint is promoted -
        // the fix must not spuriously widen untainted contracts.
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IProfileKey
    {
        string AccountId { get; }
    }

    public sealed record ProfileKey(string AccountId) : IProfileKey;
}`)
        Assert.Contains("prop AccountId string {", printed)
        Assert.Contains("data class ProfileKey(AccountId string) : IProfileKey", printed)
    }

    @Fact
    func EfEntityProperty_PromotesInterfaceAndImplementation() {
        let printed = TranslateOblivious(`
namespace Microsoft.EntityFrameworkCore
{
    public class DbSet<T> { }
}

namespace Demo
{
    using Microsoft.EntityFrameworkCore;

    public interface IPerson
    {
        string Name { get; set; }
    }

    public class Author : IPerson
    {
        public string Name { get; set; }
    }

    public class Context
    {
        public DbSet<Author> Authors { get; set; }
    }
}`)
        Assert.Equal(2, printed.Split("prop Name string?", StringSplitOptions.None).Length - 1)
    }

    @Fact
    func NullableEnabledCompilation_IsUnaffected() {
        // The oblivious taint analysis is gated to nullable-DISABLED
        // compilations (issue #2113); a nullable-enabled compilation must be
        // byte-identical to its own (correct, compiler-checked) annotations.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
#nullable enable
namespace Demo
{
    public interface IProfileKey
    {
        string AccountId { get; }
    }

    public sealed record ProfileKey(string AccountId) : IProfileKey;

    public static class Repro
    {
        public static bool IsEmpty(ProfileKey key) => key.AccountId == null!;
    }
}`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("prop AccountId string {", printed)
        Assert.Contains("data class ProfileKey(AccountId string) : IProfileKey", printed)
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
