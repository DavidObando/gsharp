// <copyright file="Issue2154CompoundOperatorTranslationTests.cs" company="GSharp">
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

/// Issue #2154: cs2gs already emitted a C# compound-assignment EXPRESSION
/// (`lhs op= rhs`) verbatim as its G# translation target — including when
/// the LHS is a member access into a type with a user-defined operator
/// overload (`obj.Field *= 2`) — via the generic
/// `AssignmentStatement(target, rhs, op)` path in
/// `TranslateExpressionStatement`. That emission was correct G# syntax,
/// but it failed to ROUND-TRIP PARSE in gsc, because gsc's parser only
/// recognized `+=`/`-=` on a member-access LHS (any other compound
/// operator on `obj.Field` reported `GS0005`). Now that gsc accepts
/// any compound operator on a member-access LHS (issue #2154's gsc-side fix),
/// cs2gs's existing pass-through translation for compound-assignment
/// expressions on a member with a user-defined operator overload round-trips
/// cleanly with no code changes needed on the cs2gs side — this is a
/// regression test proving that end-to-end.
open class Issue2154CompoundOperatorTranslationTests {
    @Theory
    @InlineData("*=")
    @InlineData("/=")
    @InlineData("%=")
    func MemberAccessCompoundAssignment_WithUserOperatorOverload_TranslatesAndRoundTrips(compoundToken string) {
        let source = (`
using System;
namespace Demo
{
    public struct Vec
    {
        public int X;

        public static Vec operator *(Vec a, int s) => new Vec { X = a.X * s };
        public static Vec operator /(Vec a, int s) => new Vec { X = a.X / s };
        public static Vec operator %(Vec a, int s) => new Vec { X = a.X % s };
    }

    public class Holder
    {
        public Vec V;
    }

    public class C
    {
        public void M()
        {
            var h = new Holder();
            h.V ` + "$compoundToken" + ` 3;
            Console.WriteLine(h.V.X);
        }
    }
}
`)
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("h.V $compoundToken 3", printed)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(
            result!!.Success,
            "Translated compound-assignment member access must round-trip-parse. Errors:\n" + string.Join(
                "\n",
                result!!.Errors
            ) +
                `

Printed:
` +
                printed
        )
    }
}
