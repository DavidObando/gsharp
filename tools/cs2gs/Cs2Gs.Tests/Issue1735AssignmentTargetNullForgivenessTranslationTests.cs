// <copyright file="Issue1735AssignmentTargetNullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #1735, three follow-up gaps in the
/// nullable-receiver <c>!!</c> assertion machinery added by #1594/#1598:
///
/// <list type="number">
/// <item>
/// <see cref="CSharpToGSharpTranslator"/>'s assignment-target path
/// (<c>TranslateAssignmentTarget</c>) returned early for an implicit-this
/// instance property/field receiver, so a nullable receiver on the LEFT of an
/// assignment never got the same <c>!!</c> its read-side twin gets — emitting
/// an unforgiven <c>this.Prop.Member = v</c> (GS0158) instead of
/// <c>this.Prop!!.Member = v</c>.
/// </item>
/// <item>
/// That same branch hard-coded <c>this</c> even inside a lifted owned-struct
/// receiver-clause method (issue #938), where the receiver is not <c>this</c>
/// but the receiver-clause parameter (<c>self</c>).
/// </item>
/// <item>
/// A delegate/event invoked via the explicit <c>.Invoke(...)</c> spelling
/// bypassed the #1598 callee-forgiveness path entirely (only the direct-call
/// sugar <c>d(args)</c> routed through it), so a nullable delegate field
/// invoked as <c>field.Invoke(x)</c> emitted a bare, unforgiven
/// <c>field(x)</c> (GS0131).
/// </item>
/// </list>
/// </summary>
public class Issue1735AssignmentTargetNullForgivenessTranslationTests
{
    [Fact]
    public void ImplicitThisNullableProperty_AssignmentTarget_EmitsNonNullAssertion()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class C
    {
        private Inner? Child => new Inner();
        public void F()
        {
            if (Child == null) return;
            Child.Value = 5;
        }
    }
}");

        Assert.Contains("this.Child!!.Value = 5", printed);
    }

    [Fact]
    public void ExplicitNullableReceiver_AssignmentTarget_EmitsNonNullAssertion()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class Outer { public Inner? Child => null; }
    public class C
    {
        public void F(Outer o)
        {
            if (o.Child == null) return;
            o.Child.Value = 5;
        }
    }
}");

        Assert.Contains("o.Child!!.Value = 5", printed);
    }

    [Fact]
    public void OwnedStructReceiverClause_ImplicitThisNullableField_UsesActualReceiverNotThis()
    {
        // Issue #938: a struct instance method is lifted to the receiver-clause
        // form (`func (self Vec) F()`), so an implicit-this reference inside the
        // body must qualify through the receiver-clause parameter, not `this`
        // (which does not exist there). Combined with the nullable-receiver
        // assertion, the assignment target must read `self.Child!!.Value = 5`.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public struct Vec
    {
        public Inner? Child;
        public void F()
        {
            if (Child == null) return;
            Child.Value = 5;
        }
    }
}");

        Assert.DoesNotContain("this.Child", printed);
        Assert.Contains("self.Child!!.Value = 5", printed);
    }

    [Fact]
    public void NonNullableReceiver_AssignmentTarget_DoesNotAssert()
    {
        // Precision guard: a non-nullable implicit-this property/field receiver
        // still needs the `this.` qualification (GS0158/GS9998) but must never
        // get a spurious `!!`.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class C
    {
        private Inner Child { get; } = new Inner();
        public void F()
        {
            Child.Value = 5;
        }
    }
}");

        Assert.Contains("this.Child.Value = 5", printed);
        Assert.DoesNotContain("!!", printed);
    }

    [Fact]
    public void NullableDelegateField_ExplicitInvokeSpelling_EmitsNonNullAssertion()
    {
        // Issue #1598 forgives the callee of the direct-call sugar `field(x)`.
        // The explicit `.Invoke(x)` spelling must be forgiven identically.
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        private Action<int>? handler;
        public void F()
        {
            if (handler == null) return;
            handler.Invoke(1);
        }
    }
}");

        Assert.Contains("handler!!(1)", printed);
    }

    [Fact]
    public void NonNullableDelegateField_ExplicitInvokeSpelling_DoesNotAssert()
    {
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        private Action<int> handler = _ => { };
        public void F()
        {
            handler.Invoke(1);
        }
    }
}");

        Assert.DoesNotContain("!!", printed);
        Assert.Contains("handler(1)", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
