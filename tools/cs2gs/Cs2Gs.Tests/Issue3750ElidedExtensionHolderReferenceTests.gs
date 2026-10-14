// <copyright file="Issue3750ElidedExtensionHolderReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #3750: a C# `static class` holding only extension methods is
/// lowered to top-level receiver-clause funcs; originally the holder itself
/// was elided (ADR-0115 §B.5) unless a surviving reference to it BY NAME
/// would otherwise name a type that no longer exists (`GS0113`, or
/// `GS0159` where the result feeds a member lookup).
///
/// Issue #4234 removed the elision entirely: the lifted funcs carried the
/// holder's behaviour but not its CLR owner-type identity, which a
/// self-hosted build of the SAME method still needs (reflection tests,
/// analyzer owner-specific recognition key off the exact declaring type) —
/// a need the single-file view here can never rule out. The holder now
/// always survives, empty, and the lifted func carries an
/// `@ExtensionOwner(typeof(T))` back-reference so gsc hosts its
/// MethodDef on the holder's TypeDef instead of the package's
/// `<Program>`. The class name kept its original #3750 framing
/// (surviving-reference cases) since those assertions are still valid; the
/// elision-still-happens tests below were updated to assert survival instead.
open class Issue3750ElidedExtensionHolderReferenceTests {
    /// #3745 family F6: `test/Compiler.Tests/Emit/ClrInteropEmitTests.cs`
    /// holds one extension in `NamedParamsExtensionFixture` and names that
    /// class from `typeof(NamedParamsExtensionFixture).Assembly.Location`.
    @Fact
    func TypeOfElidedHolder_KeepsHolderDeclaration() {
        let printed = TranslateFiles(("Extensions.cs", `
namespace Demo;

public static class NamedParamsExtensionFixture
{
    public static string Describe(this string source, int statusCode) =>
        source + statusCode;
}`), ("Use.cs", `
using System;

namespace Demo;

public sealed class Consumer
{
    public string Location() => typeof(NamedParamsExtensionFixture).Assembly.Location;

    public string Call() => "x".Describe(200);
}`))
        // The extension still lifts to the idiomatic receiver-clause func …
        Assert.Contains("func (source string) Describe(", printed["Extensions.cs"])
        // … and the holder survives only as the empty type its identity needs.
        Assert.Contains("class NamedParamsExtensionFixture {", printed["Extensions.cs"])
        Assert.Contains("typeof(NamedParamsExtensionFixture)", printed["Use.cs"])
    }

    /// #3684 family F1b: the same defect through a namespace-qualified
    /// reference (`typeof(Fixtures.Handler322Extensions).Assembly.Location`
    /// in migrated `test/Core.Tests`), which was originally mis-diagnosed
    /// as a dropped import qualifier.
    @Fact
    func QualifiedTypeOfElidedHolder_KeepsHolderDeclaration() {
        let printed = TranslateFiles(("Fixture.cs", `
using System;

namespace Demo.Fixtures;

public static class Handler322Extensions
{
    public static string Handle(this string source, Delegate handler) =>
        source + (string)handler.DynamicInvoke();
}`), ("Use.cs", `
using System;
using Demo.Fixtures;

namespace Demo;

public sealed class Consumer
{
    public string Location() => typeof(Handler322Extensions).Assembly.Location;
}`))
        Assert.Contains("func (source string) Handle(", printed["Fixture.cs"])
        Assert.Contains("class Handler322Extensions {", printed["Fixture.cs"])
        Assert.Contains("import Demo.Fixtures", printed["Use.cs"])
        Assert.Contains("typeof(Handler322Extensions)", printed["Use.cs"])
    }

    /// The attribute-argument form of the same reference: an attribute argument
    /// is an ordinary `typeof` expression, so it keeps the holder alive too.
    @Fact
    func TypeOfInAttributeArgument_KeepsHolderDeclaration() {
        let printed = TranslateFiles(("Attr.cs", `
using System;

namespace Demo;

[AttributeUsage(AttributeTargets.Class)]
public sealed class CoveredByAttribute : Attribute
{
    public CoveredByAttribute(Type target) => Target = target;

    public Type Target { get; }
}`), ("Extensions.cs", `
namespace Demo;

public static class AttributeReferencedExtensions
{
    public static int Twice(this int value) => value * 2;
}`), ("Use.cs", `
namespace Demo;

[CoveredBy(typeof(AttributeReferencedExtensions))]
public sealed class Consumer
{
    public int Call() => 21.Twice();
}`))
        Assert.Contains("func (value int32) Twice(", printed["Extensions.cs"])
        Assert.Contains("class AttributeReferencedExtensions {", printed["Extensions.cs"])
        Assert.Contains("typeof(AttributeReferencedExtensions)", printed["Use.cs"])
    }

    /// Issue #4234: the holder is no longer elided even in the overwhelmingly
    /// common case where nothing in THIS translation unit names it by
    /// identity. A self-hosted build of the migrated method still needs the
    /// holder's CLR TypeDef to give the extension its native owner-type
    /// identity back (reflection tests, analyzer owner-specific recognition)
    /// — a concern the single-file view here cannot rule out — so the holder
    /// survives empty and the lifted func carries an
    /// `@ExtensionOwner(typeof(T))` back-reference to it.
    @Fact
    func UnreferencedHolder_StillSurvivesForOwnerIdentity() {
        let printed = TranslateFiles(("Extensions.cs", `
namespace Demo;

public static class QuietExtensions
{
    public static string Describe(this string source, int statusCode) =>
        source + statusCode;
}`), ("Use.cs", `
namespace Demo;

public sealed class Consumer
{
    public string Call() => "x".Describe(200);
}`))
        Assert.Contains("func (source string) Describe(", printed["Extensions.cs"])
        Assert.Contains("class QuietExtensions {\n}", printed["Extensions.cs"])
        Assert.Contains("@ExtensionOwner(typeof(QuietExtensions))", printed["Extensions.cs"])
    }

    /// Issue #4234: a static-form call through the holder is already
    /// rewritten to the receiver form, so nothing in `Use.cs` names the
    /// holder — but `Extensions.cs` still keeps its own declaration for
    /// the same owner-identity reason as
    /// (cref:UnreferencedHolder_StillSurvivesForOwnerIdentity).
    @Fact
    func StaticFormCallThroughHolder_StillKeepsHolderDeclarationForOwnerIdentity() {
        let printed = TranslateFiles(("Extensions.cs", `
namespace Demo;

public static class StaticFormExtensions
{
    public static string Describe(this string source, int statusCode) =>
        source + statusCode;
}`), ("Use.cs", `
namespace Demo;

public sealed class Consumer
{
    public string Call() => StaticFormExtensions.Describe("x", 200);
}`))
        Assert.Contains("class StaticFormExtensions {\n}", printed["Extensions.cs"])
        Assert.DoesNotContain("StaticFormExtensions", printed["Use.cs"])
        Assert.Contains("\"x\".Describe(200)", printed["Use.cs"])
    }

    /// Issue #4234: `nameof(Holder)` constant-folds to a string literal
    /// before the printer sees it, so `Use.cs` never names the holder —
    /// but `Extensions.cs` still keeps its own declaration for the same
    /// owner-identity reason as
    /// (cref:UnreferencedHolder_StillSurvivesForOwnerIdentity).
    @Fact
    func NameOfHolder_FoldsToLiteralButHolderStillSurvives() {
        let printed = TranslateFiles(("Extensions.cs", `
namespace Demo;

public static class NameOfExtensions
{
    public static int Twice(this int value) => value * 2;
}`), ("Use.cs", `
namespace Demo;

public sealed class Consumer
{
    public string Name() => nameof(NameOfExtensions);
}`))
        Assert.Contains("class NameOfExtensions {\n}", printed["Extensions.cs"])
        Assert.Contains("\"NameOfExtensions\"", printed["Use.cs"])
    }

    /// Issue #4234: a `typeof` reference living in a file this
    /// translation does not emit cannot itself keep the holder alive — but
    /// the holder now survives regardless, for the same owner-identity
    /// reason as (cref:UnreferencedHolder_StillSurvivesForOwnerIdentity),
    /// so this no longer distinguishes an excluded-file reference from no
    /// reference at all.
    @Fact
    func TypeOfInExcludedFile_HolderStillSurvives() {
        let printed = TranslateFiles(
            CSharpToGSharpTranslator(retainedFilePaths: []string{"Extensions.cs"}),
            validate: false,
            ("Extensions.cs", `
namespace Demo;

public static class ExcludedReferenceExtensions
{
    public static int Twice(this int value) => value * 2;
}`),
            ("Generated.cs", `
using System;

namespace Demo;

public sealed class Consumer
{
    public string Location() => typeof(ExcludedReferenceExtensions).Assembly.Location;
}`)
        )
        Assert.Contains("class ExcludedReferenceExtensions {\n}", printed["Extensions.cs"])
    }

    shared {
        private func TranslateFiles(files ...(FileName string, Source string)) IReadOnlyDictionary[string, string] {
            return TranslateFiles(CSharpToGSharpTranslator(), validate: true, files)
        }

        private func TranslateFiles(
            translator CSharpToGSharpTranslator,
            validate bool,
            files ...(FileName string, Source string)
        ) IReadOnlyDictionary[string, string] {
            let project = CSharpProjectLoader.LoadInMemory(files)
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let result = Dictionary[string, string](StringComparer.Ordinal)
            for document in project.Documents {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let unit = translator.TranslateDocument(document, context)
                result.Add(document.FilePath, GSharpPrinter.Print(unit))
            }
            if validate {
                TranslationTestValidation.AssertBinds(result.Values.ToArray())
            }
            return result
        }
    }
}
