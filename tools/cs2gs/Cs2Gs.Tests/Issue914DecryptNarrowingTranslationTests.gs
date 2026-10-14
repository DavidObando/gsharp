// <copyright file="Issue914DecryptNarrowingTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Regression tests for the `Oahu.Decrypt` migration fixes tracked under
/// issue #914: narrowing of declaration-pattern bindings, assignment-LHS
/// null-forgiveness / `this`-qualification, null-conditional enum-extension
/// lowering, and nullable-arm typing of a ternary with a `null` branch.
/// Each snippet must round-trip-parse through the real G# parser.
open class Issue914DecryptNarrowingTranslationTests {
    /// Assigning through an implicit-`this` property receiver
    /// (`Header.FilePosition = x`) must qualify the receiver as
    /// `this.Header.FilePosition`; gsc rejects (ICEs on) the bare
    /// implicit-this property receiver as an assignment target (GS0158/GS9998).
    @Fact
    func AssignmentToImplicitThisPropertyMember_QualifiesThis() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Hdr { public long FilePosition { get; set; } }

    public sealed class Box
    {
        public Hdr Header { get; } = new Hdr();

        public void Init(long pos)
        {
            Header.FilePosition = pos;
        }
    }
}`)
        Assert.Contains("this.Header.FilePosition = pos", printed)
    }

    /// A positive type-pattern guard whose scrutinee is not smart-castable
    /// (here a method call) used to be hoisted to a nullable local, forcing a
    /// null-forgiven assignment receiver (`x!!.Member = …`). ADR-0166 /
    /// issue #3409: the binder is now a native pattern variable of the tested
    /// (non-nullable) type, so writing through it inside the guard needs no
    /// hoist and no `!!`.
    @Fact
    func AssignmentThroughPatternVariable_UsesNativePatternVariableWithoutNullForgiveness() {
        let printed = TranslateUnit(`
namespace Demo
{
    public interface IRefs { int[] TrackIds { get; set; } }
    public sealed class RefBox : IRefs { public int[] TrackIds { get; set; } = System.Array.Empty<int>(); }

    public sealed class Owner
    {
        public IRefs Lookup() => new RefBox();

        public void Apply(int[] references)
        {
            if (Lookup() is IRefs referenceType)
            {
                referenceType.TrackIds = references;
            }
        }
    }
}`)
        // ADR-0166 / issue #3409: native pattern variable; the assignment receiver
        // is the non-nullable binder itself.
        Assert.Contains("if Lookup() is IRefs referenceType {", printed)
        Assert.Contains("referenceType.TrackIds = references", printed)
        Assert.DoesNotContain("!!", printed)
        Assert.DoesNotContain("as IRefs", printed)
        Assert.DoesNotContain("__spill", printed)
    }

    /// Issue #3357: a null-conditional enum extension call retains its native
    /// member-binding form and needs no guarded static-helper lowering.
    @Fact
    func NullConditionalEnumExtension_RetainsMemberCall() {
        let printed = TranslateUnit(`
namespace Demo
{
    public enum Groups { A, B }

    public static class Ext
    {
        public static int Count(this Groups g) => 1;
    }

    public sealed class C
    {
        public Groups? G;

        public int? Read() => G?.Count();
    }
}`)
        Assert.Contains("G?.Count()", printed)
        Assert.DoesNotContain("Ext.Count(", printed)
        Assert.DoesNotContain("__spill", printed)
    }

    /// A ternary with a `null` arm over a reference type
    /// (`cond ? value : null`) must re-emit the null arm as
    /// `default(T?)` carrying the mapped nullable type; a bare `nil`
    /// leaves gsc unable to unify the branches into the nullable union (GS0155).
    @Fact
    func TernaryWithNullArm_EmitsTypedDefaultForReferenceResult() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public string? Pick(bool b, string s) => b ? s : null;
    }
}`)
        Assert.Contains("default(string?)", printed)
        Assert.DoesNotContain("else { nil }", printed)
    }

    @Fact
    func AsyncNullableReturn_DoesNotAssertNullTernaryResult() {
        let printed = TranslateUnit(`
#nullable enable
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public async Task<string?> PickAsync(bool found)
        {
            await Task.Yield();
            return found ? "value" : null;
        }
    }
}`)
        Assert.Contains("async func PickAsync(found bool) string?", printed)
        Assert.Contains("default(string?)", printed)
        Assert.DoesNotContain("default(string?))!!", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
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
