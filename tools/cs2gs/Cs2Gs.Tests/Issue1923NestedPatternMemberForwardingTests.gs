// <copyright file="Issue1923NestedPatternMemberForwardingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1923 (regression, round 2): the `isNestedPatternMember` flag —
/// which suppresses a redundant `!= nil` guard on a nested pattern member
/// that is provably non-nullable — was threaded through the direct recursive
/// member-access re-entry into `TranslatePatternTest`, but NOT through
/// three other recursive re-entry points: the `not`-pattern dispatch, the
/// list-element loop, and the slice-pattern subpattern. Reaching a nested
/// recursive pattern through any of those paths silently reset the flag to
/// its default (`false`), reproducing the exact "unconditional
/// redundant nil-check on a non-nullable nested member" bug the flag exists to
/// suppress. These tests cover both gap-closing shapes and a control case
/// proving the outer-nullable scenario still gets its own guard.
open class Issue1923NestedPatternMemberForwardingTests {
    @Fact
    func PropertySubpattern_NotPattern_SkipsRedundantNilCheckOnNonNullableMember() {
        let rendered = Render(`
namespace Corpus.Issue1923
{
    public class Address
    {
        public int Age;
    }

    public class Person
    {
        public Address Friend;
    }

    public class Holder
    {
        public bool Describe(Person person)
        {
            return person is { Friend: not { Age: 0 } };
        }
    }
}
`)
        // `Friend` is declared non-nullable, so the nested `not { Age: 0 }`
        // re-entry must NOT re-emit `person.Friend != nil`.
        Assert.DoesNotContain("person.Friend != nil", rendered, StringComparison.Ordinal)
        Assert.Contains("person.Friend.Age", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func PropertySubpattern_ListElementPattern_SkipsRedundantNilCheckOnNonNullableMember() {
        let rendered = Render(`
namespace Corpus.Issue1923
{
    public class Address
    {
        public int Age;
    }

    public class Person
    {
        public Address[] Friends;
    }

    public class Holder
    {
        public bool Describe(Person person)
        {
            return person is { Friends: [{ Age: 0 }] };
        }
    }
}
`)
        // `Friends` is declared non-nullable, so the nested element subpattern
        // re-entry must NOT re-emit `person.Friends != nil`.
        Assert.DoesNotContain("person.Friends != nil", rendered, StringComparison.Ordinal)
        Assert.Contains("Age", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func PropertySubpattern_NotPattern_KeepsNilCheckWhenMemberIsNullable() {
        let rendered = Render(`
namespace Corpus.Issue1923
{
    public class Address
    {
        public int Age;
    }

    public class Person
    {
        public Address? Friend;
    }

    public class Holder
    {
        public bool Describe(Person person)
        {
            return person is { Friend: not { Age: 0 } };
        }
    }
}
`)
        // `Friend` is declared nullable, so a nil member must still be handled —
        // the fix must not over-correct into dropping that. Issue #4356: a nullable member tested through a nested property
        // pattern now takes G#'s native pattern, which reads `Friend` once and
        // keeps C#'s semantics for a nil member (`not { Age: 0 }` matches it;
        // pinned at run time by Issue4356's NestedMemberSubpatterns_ReadTheMemberOnce).
        Assert.Contains("person is { Friend: not { Age: 0 } }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string, roundTripOnlyReason string? = nil) {
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(rendered)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(rendered, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
